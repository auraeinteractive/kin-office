#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/stat.h>

#include "templates.h"

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

int main(int argc, char* argv[])
{
    const char* action = get_arg_value(argc, argv, "action");
    const char* type = get_arg_value(argc, argv, "type");
    const char* input = get_arg_value(argc, argv, "input");
    const char* output = get_arg_value(argc, argv, "output");
    const char* username = get_arg_value(argc, argv, "username");
    const char* sessionid = get_arg_value(argc, argv, "sessionid");
    const char* path = get_arg_value(argc, argv, "path");
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

    print_fail("Unknown action (supported: template, open, savefile, downloadas, session).");
    return 1;
}
