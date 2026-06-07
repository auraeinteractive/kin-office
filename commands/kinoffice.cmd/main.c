#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/stat.h>

#include "templates.h"

static const char* g_argv0 = NULL;

static const char* get_arg_value(int argc, char* argv[], const char* key)
{
    int key_len = (int)strlen(key);
    for (int i = 1; i < argc; i++) {
        if (strncmp(argv[i], key, key_len) == 0 && argv[i][key_len] == '=')
            return argv[i] + key_len + 1;
    }
    return NULL;
}

static void print_fail(const char* msg)
{
    printf("{\"response\":\"fail\",\"message\":\"%s\"}\n", msg ? msg : "unknown error");
}

static void print_success_template(const char* type, const char* b64, size_t raw_len)
{
    printf("{\"response\":\"success\",\"action\":\"template\",\"fileType\":\"%s\",\"size\":%zu,\"data_base64\":\"%s\"}\n",
           type, raw_len, b64);
}

static void json_print_escaped(const char* value)
{
    const unsigned char* p = (const unsigned char*)(value ? value : "");
    putchar('"');
    while (*p) {
        unsigned char c = *p++;
        if (c == '"' || c == '\\') {
            putchar('\\');
            putchar((int)c);
        } else if (c == '\n') {
            fputs("\\n", stdout);
        } else if (c == '\r') {
            fputs("\\r", stdout);
        } else if (c == '\t') {
            fputs("\\t", stdout);
        } else if (c < 0x20) {
            printf("\\u%04x", c);
        } else {
            putchar((int)c);
        }
    }
    putchar('"');
}

static void json_escape_append(char* out, size_t cap, size_t* pos, const char* value)
{
    const unsigned char* p = (const unsigned char*)(value ? value : "");
    if (*pos + 1 >= cap) return;
    out[(*pos)++] = '"';
    while (*p && *pos + 8 < cap) {
        unsigned char c = *p++;
        if (c == '"' || c == '\\') {
            out[(*pos)++] = '\\';
            out[(*pos)++] = (char)c;
        } else if (c == '\n') {
            out[(*pos)++] = '\\';
            out[(*pos)++] = 'n';
        } else if (c == '\r') {
            out[(*pos)++] = '\\';
            out[(*pos)++] = 'r';
        } else if (c == '\t') {
            out[(*pos)++] = '\\';
            out[(*pos)++] = 't';
        } else if (c < 0x20) {
            int n = snprintf(out + *pos, cap - *pos, "\\u%04x", c);
            if (n < 0) return;
            *pos += (size_t)n;
        } else {
            out[(*pos)++] = (char)c;
        }
    }
    if (*pos < cap) out[(*pos)++] = '"';
    if (*pos < cap) out[*pos] = '\0';
}

static int path_is_safe_host_file(const char* path)
{
    if (!path || !*path)
        return 0;
    if (strstr(path, ".."))
        return 0;
    return strncmp(path, "/tmp/", 5) == 0 || strncmp(path, "/var/tmp/", 9) == 0;
}

static int office_zip_file_size(const char* path, size_t* out_size)
{
    unsigned char sig[4];
    struct stat st;
    FILE* f;

    if (!path_is_safe_host_file(path))
        return -1;
    if (stat(path, &st) != 0 || !S_ISREG(st.st_mode) || st.st_size <= 0)
        return -1;
    f = fopen(path, "rb");
    if (!f)
        return -1;
    if (fread(sig, 1, sizeof(sig), f) != sizeof(sig)) {
        fclose(f);
        return -1;
    }
    fclose(f);
    if (sig[0] != 0x50 || sig[1] != 0x4b || sig[2] != 0x03 || sig[3] != 0x04)
        return -1;
    if (out_size)
        *out_size = (size_t)st.st_size;
    return 0;
}

static int copy_file(const char* input, const char* output, size_t* out_size)
{
    unsigned char buf[65536];
    size_t total = 0;
    FILE* in;
    FILE* out;

    if (!path_is_safe_host_file(input) || !path_is_safe_host_file(output))
        return -1;
    in = fopen(input, "rb");
    if (!in)
        return -1;
    out = fopen(output, "wb");
    if (!out) {
        fclose(in);
        return -1;
    }
    for (;;) {
        size_t n = fread(buf, 1, sizeof(buf), in);
        if (n > 0) {
            if (fwrite(buf, 1, n, out) != n) {
                fclose(in);
                fclose(out);
                return -1;
            }
            total += n;
        }
        if (n < sizeof(buf)) {
            if (ferror(in)) {
                fclose(in);
                fclose(out);
                return -1;
            }
            break;
        }
    }
    fclose(in);
    if (fclose(out) != 0)
        return -1;
    if (out_size)
        *out_size = total;
    return 0;
}

static const kinoffice_template_t* find_template(const char* type)
{
    if (!type || !*type)
        return NULL;
    for (int i = 0; KINOFFICE_TEMPLATES[i].type; i++) {
        if (strcmp(KINOFFICE_TEMPLATES[i].type, type) == 0)
            return &KINOFFICE_TEMPLATES[i];
    }
    return NULL;
}

static int handle_template(const char* type)
{
    const kinoffice_template_t* tpl = find_template(type);
    if (!tpl) {
        print_fail("Unsupported template type (use docx, xlsx, or pptx).");
        return 1;
    }
    print_success_template(tpl->type, tpl->b64, tpl->raw_len);
    return 0;
}

static int handle_open_or_savefile(const char* action, const char* input)
{
    size_t size = 0;
    if (office_zip_file_size(input, &size) != 0) {
        print_fail("Invalid or unsupported Office document bytes.");
        return 1;
    }
    printf("{\"response\":\"success\",\"action\":\"%s\",\"size\":%zu}\n", action, size);
    return 0;
}

static int handle_downloadas(const char* input, const char* output)
{
    size_t size = 0;
    if (office_zip_file_size(input, NULL) != 0) {
        print_fail("Invalid or unsupported Office document bytes.");
        return 1;
    }
    if (copy_file(input, output, &size) != 0) {
        print_fail("Could not write converted output.");
        return 1;
    }
    printf("{\"response\":\"success\",\"action\":\"downloadas\",\"size\":%zu,\"output\":\"%s\"}\n", size, output);
    return 0;
}

static unsigned long long fnv1a64(const char* value)
{
    unsigned long long h = 1469598103934665603ULL;
    const unsigned char* p = (const unsigned char*)(value ? value : "");
    while (*p) {
        h ^= (unsigned long long)(*p++);
        h *= 1099511628211ULL;
    }
    return h;
}

static int handle_session(const char* username, const char* sessionid, const char* path, const char* type)
{
    const char* host = getenv("KINOFFICE_COLLAB_HOST");
    const char* port = getenv("KINOFFICE_COLLAB_PORT");
    unsigned long long doc_hash;
    if (!username || !*username) username = "kin-user";
    if (!sessionid) sessionid = "";
    if (!path) path = "";
    if (!type || !*type) type = "docx";
    if (!host || !*host) host = "127.0.0.1";
    if (!port || !*port) port = "19129";
    doc_hash = fnv1a64(path);

    printf("{\"response\":\"success\",\"action\":\"session\",\"user\":{\"id\":");
    json_print_escaped(username);
    printf(",\"name\":");
    json_print_escaped(username);
    printf("},\"sessionId\":");
    json_print_escaped(sessionid);
    printf(",\"documentId\":\"kin-office-%016llx\",\"path\":", doc_hash);
    json_print_escaped(path);
    printf(",\"fileType\":");
    json_print_escaped(type);
    printf(",\"collab\":{\"host\":");
    json_print_escaped(host);
    printf(",\"port\":%d,\"tls\":false}}\n", atoi(port) > 0 ? atoi(port) : 19129);
    return 0;
}

static int collab_port(void)
{
    const char* port = getenv("KINOFFICE_COLLAB_PORT");
    int n = port && *port ? atoi(port) : 19129;
    return n > 0 && n <= 65535 ? n : 19129;
}

static const char* collab_host(void)
{
    const char* host = getenv("KINOFFICE_COLLAB_HOST");
    return host && *host ? host : "127.0.0.1";
}

static int collab_host_is_loopback(const char* host)
{
    return host && (strcmp(host, "127.0.0.1") == 0 || strcmp(host, "localhost") == 0);
}

static int join_path(char* out, size_t cap, const char* a, const char* b)
{
    if (!out || !a || !b || cap == 0) return -1;
    int n = snprintf(out, cap, "%s/%s", a, b);
    return n > 0 && (size_t)n < cap ? 0 : -1;
}

static int dirname_of(const char* path, char* out, size_t cap)
{
    if (!path || !*path || !out || cap == 0) return -1;
    const char* slash = strrchr(path, '/');
    if (!slash) {
        snprintf(out, cap, ".");
        return 0;
    }
    size_t n = (size_t)(slash - path);
    if (n == 0) n = 1;
    if (n + 1 > cap) return -1;
    memcpy(out, path, n);
    out[n] = '\0';
    return 0;
}

static int find_collab_service_bin(char* out, size_t cap)
{
    const char* configured = getenv("KINOFFICE_COLLAB_SERVICE");
    if (configured && *configured && access(configured, X_OK) == 0) {
        snprintf(out, cap, "%s", configured);
        return 0;
    }
    char dir[4096];
    if (dirname_of(g_argv0, dir, sizeof(dir)) != 0) return -1;
    const char* candidates[] = {
        "../services/kinoffice-collab.service",
        "../../services/kinoffice-collab/kinoffice-collab.service",
        "/usr/lib/kin/services/kinoffice-collab.service",
        NULL
    };
    for (int i = 0; candidates[i]; i++) {
        char path[4096];
        if (candidates[i][0] == '/') snprintf(path, sizeof(path), "%s", candidates[i]);
        else if (join_path(path, sizeof(path), dir, candidates[i]) != 0) continue;
        if (access(path, X_OK) == 0) {
            snprintf(out, cap, "%s", path);
            return 0;
        }
    }
    return -1;
}

static int connect_collab_socket(const char* host, int port)
{
    const char* connect_host = (host && strcmp(host, "localhost") == 0) ? "127.0.0.1" : host;
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) return -1;
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, connect_host, &addr.sin_addr) != 1) {
        close(fd);
        errno = EINVAL;
        return -1;
    }
    if (connect(fd, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
        int saved = errno;
        close(fd);
        errno = saved;
        return -1;
    }
    return fd;
}

static void redirect_child_stdio(void)
{
    int fd = open("/dev/null", O_RDWR);
    if (fd >= 0) {
        dup2(fd, STDIN_FILENO);
        dup2(fd, STDOUT_FILENO);
        dup2(fd, STDERR_FILENO);
        if (fd > STDERR_FILENO) close(fd);
    }
}

static int start_collab_service_if_needed(const char* host, int port)
{
    if (!collab_host_is_loopback(host)) return -1;
    char service_bin[4096];
    if (find_collab_service_bin(service_bin, sizeof(service_bin)) != 0) return -1;
    pid_t pid = fork();
    if (pid < 0) return -1;
    if (pid == 0) {
        setsid();
        redirect_child_stdio();
        char port_arg[32];
        snprintf(port_arg, sizeof(port_arg), "%d", port);
        setenv("KINOFFICE_COLLAB_HOST", host, 1);
        setenv("KINOFFICE_COLLAB_PORT", port_arg, 1);
        execl(service_bin, service_bin, "--host", host, "--port", port_arg, (char*)NULL);
        _exit(127);
    }
    return 0;
}

static int write_all(int fd, const char* data, size_t n)
{
    size_t off = 0;
    while (off < n) {
        ssize_t w = write(fd, data + off, n - off);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return -1;
        off += (size_t)w;
    }
    return 0;
}

static char* read_line_alloc(int fd)
{
    size_t cap = 4096;
    size_t pos = 0;
    char* out = (char*)malloc(cap);
    if (!out) return NULL;
    for (;;) {
        char ch;
        ssize_t n = read(fd, &ch, 1);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) {
            free(out);
            return NULL;
        }
        if (ch == '\n') break;
        if (ch == '\r') continue;
        if (pos + 2 >= cap) {
            size_t next = cap * 2;
            char* grown;
            if (next > 2097152) {
                free(out);
                return NULL;
            }
            grown = (char*)realloc(out, next);
            if (!grown) {
                free(out);
                return NULL;
            }
            out = grown;
            cap = next;
        }
        out[pos++] = ch;
    }
    out[pos] = '\0';
    return out;
}

static int collab_roundtrip(const char* request)
{
    const char* host = collab_host();
    int port = collab_port();
    int fd = connect_collab_socket(host, port);
    if (fd < 0 && errno == EINVAL) {
        print_fail("Invalid collaboration service host.");
        return 1;
    }
    if (fd < 0) {
        if (start_collab_service_if_needed(host, port) == 0) {
            for (int i = 0; i < 20 && fd < 0; i++) {
                usleep(50000);
                fd = connect_collab_socket(host, port);
            }
        }
    }
    if (fd < 0) {
        print_fail("Collaboration service is not reachable.");
        return 1;
    }
    if (write_all(fd, request, strlen(request)) != 0 || write_all(fd, "\n", 1) != 0) {
        close(fd);
        print_fail("Could not send collaboration bridge request.");
        return 1;
    }
    char* response = read_line_alloc(fd);
    close(fd);
    if (!response) {
        print_fail("Collaboration service returned no response.");
        return 1;
    }
    printf("%s\n", response);
    free(response);
    return 0;
}

static int raw_json_object_is_safe(const char* value)
{
    if (!value) return 0;
    while (*value == ' ' || *value == '\t') value++;
    if (*value != '{') return 0;
    return strchr(value, '\n') == NULL && strchr(value, '\r') == NULL;
}

static int handle_collab_bridge(const char* action, const char* username, const char* sessionid,
                                const char* client_id, const char* document_id,
                                const char* path, const char* type, const char* message)
{
    if (!client_id || !*client_id) {
        print_fail("Missing clientId for collaboration bridge.");
        return 1;
    }
    const char* op = NULL;
    if (strcmp(action, "collab_join") == 0) op = "join";
    else if (strcmp(action, "collab_send") == 0) op = "send";
    else if (strcmp(action, "collab_poll") == 0) op = "poll";
    else if (strcmp(action, "collab_leave") == 0) op = "leave";
    else {
        print_fail("Unknown collaboration bridge action.");
        return 1;
    }
    if (!username || !*username) username = "kin-user";
    if (!sessionid) sessionid = "";
    if (!type || !*type) type = "docx";
    if (strcmp(op, "join") == 0 && (!document_id || !*document_id || !path || !*path)) {
        print_fail("Missing documentId or path for collaboration join.");
        return 1;
    }
    if (strcmp(op, "send") == 0 && !raw_json_object_is_safe(message)) {
        print_fail("Invalid collaboration message JSON.");
        return 1;
    }

    size_t cap = (message ? strlen(message) : 0) + 8192;
    char* req = (char*)calloc(1, cap);
    if (!req) {
        print_fail("Out of memory.");
        return 1;
    }
    size_t p = 0;
    p += (size_t)snprintf(req + p, cap - p, "{\"type\":\"bridge\",\"op\":");
    json_escape_append(req, cap, &p, op);
    p += (size_t)snprintf(req + p, cap - p, ",\"clientId\":");
    json_escape_append(req, cap, &p, client_id);
    if (strcmp(op, "join") == 0) {
        p += (size_t)snprintf(req + p, cap - p, ",\"user\":");
        json_escape_append(req, cap, &p, username);
        p += (size_t)snprintf(req + p, cap - p, ",\"sessionId\":");
        json_escape_append(req, cap, &p, sessionid);
        p += (size_t)snprintf(req + p, cap - p, ",\"documentId\":");
        json_escape_append(req, cap, &p, document_id);
        p += (size_t)snprintf(req + p, cap - p, ",\"path\":");
        json_escape_append(req, cap, &p, path);
        p += (size_t)snprintf(req + p, cap - p, ",\"fileType\":");
        json_escape_append(req, cap, &p, type);
    } else if (strcmp(op, "send") == 0) {
        p += (size_t)snprintf(req + p, cap - p, ",\"message\":%s", message);
    }
    p += (size_t)snprintf(req + p, cap - p, "}");
    int rc = collab_roundtrip(req);
    free(req);
    return rc;
}

int main(int argc, char* argv[])
{
    g_argv0 = argv[0];
    const char* action = get_arg_value(argc, argv, "action");
    const char* type = get_arg_value(argc, argv, "type");
    const char* input = get_arg_value(argc, argv, "input");
    const char* output = get_arg_value(argc, argv, "output");
    const char* username = get_arg_value(argc, argv, "username");
    const char* sessionid = get_arg_value(argc, argv, "sessionid");
    const char* path = get_arg_value(argc, argv, "path");
    const char* client_id = get_arg_value(argc, argv, "clientId");
    const char* document_id = get_arg_value(argc, argv, "documentId");
    const char* message = get_arg_value(argc, argv, "message");
    const char* manager_pid_arg = get_arg_value(argc, argv, "manager_pid");
    const char* manager_pid_env = getenv("KIN_MANAGER_PID");
    int manager_pid = 0;

    if (manager_pid_arg && *manager_pid_arg)
        manager_pid = atoi(manager_pid_arg);
    else if (manager_pid_env && *manager_pid_env)
        manager_pid = atoi(manager_pid_env);

    /* manager_pid is required when launched from Kin IPC; allow CLI template checks without it. */
    (void)manager_pid;

    if (!action || !*action) {
        print_fail("Missing action=template.");
        return 1;
    }

    if (strcmp(action, "template") == 0)
        return handle_template(type);
    if (strcmp(action, "open") == 0)
        return handle_open_or_savefile("open", input);
    if (strcmp(action, "savefile") == 0)
        return handle_open_or_savefile("savefile", input);
    if (strcmp(action, "downloadas") == 0)
        return handle_downloadas(input, output);
    if (strcmp(action, "session") == 0)
        return handle_session(username, sessionid, path, type);
    if (strncmp(action, "collab_", 7) == 0)
        return handle_collab_bridge(action, username, sessionid, client_id, document_id, path, type, message);

    print_fail("Unknown action (supported: template, open, savefile, downloadas, session, collab_join, collab_send, collab_poll, collab_leave).");
    return 1;
}
