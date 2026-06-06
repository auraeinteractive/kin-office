#define _GNU_SOURCE
#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <time.h>
#include <unistd.h>

#define KO_MAX_LINE 1048576
#define KO_MAX_DOCUMENT_ID 128
#define KO_MAX_PATH 2048
#define KO_MAX_TYPE 16
#define KO_MAX_USER 256
#define KO_DEFAULT_HOST "127.0.0.1"
#define KO_DEFAULT_PORT 19129

typedef struct KoClient KoClient;

typedef struct KoLock {
    char key[256];
    char user[KO_MAX_USER];
    struct KoLock* next;
} KoLock;

typedef struct KoRoom {
    char document_id[KO_MAX_DOCUMENT_ID];
    char kin_path[KO_MAX_PATH];
    char file_type[KO_MAX_TYPE];
    unsigned long changes_index;
    unsigned long participants_timestamp;
    KoLock* locks;
    KoClient* clients;
    struct KoRoom* next;
} KoRoom;

struct KoClient {
    int fd;
    char username[KO_MAX_USER];
    char session_id[256];
    char document_id[KO_MAX_DOCUMENT_ID];
    char kin_path[KO_MAX_PATH];
    char file_type[KO_MAX_TYPE];
    int index_user;
    KoRoom* room;
    KoClient* next_in_room;
};

static volatile int g_running = 1;
static volatile int g_listener_fd = -1;
static pthread_mutex_t g_rooms_lock = PTHREAD_MUTEX_INITIALIZER;
static KoRoom* g_rooms = NULL;
static int g_next_index_user = 1;

static void handle_signal(int sig)
{
    (void)sig;
    g_running = 0;
    if (g_listener_fd >= 0) close(g_listener_fd);
}

static long ko_now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_REALTIME, &ts);
    return (long)ts.tv_sec * 1000L + (long)(ts.tv_nsec / 1000000L);
}

static int write_all(int fd, const void* buf, size_t n)
{
    const char* p = (const char*)buf;
    size_t s = 0;
    while (s < n) {
        ssize_t w = write(fd, p + s, n - s);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return -1;
        s += (size_t)w;
    }
    return 0;
}

static int write_line(int fd, const char* line)
{
    if (!line) return -1;
    size_t n = strlen(line);
    if (write_all(fd, line, n) != 0) return -1;
    if (n == 0 || line[n - 1] != '\n') return write_all(fd, "\n", 1);
    return 0;
}

static int read_line_dynamic(int fd, char** out)
{
    size_t cap = 4096;
    size_t pos = 0;
    char* buf = (char*)malloc(cap);
    if (!buf) return -1;
    for (;;) {
        char ch;
        ssize_t n = read(fd, &ch, 1);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) {
            free(buf);
            return -1;
        }
        if (ch == '\n') break;
        if (ch == '\r') continue;
        if (pos + 2 >= cap) {
            if (cap >= KO_MAX_LINE) {
                free(buf);
                return -1;
            }
            size_t next = cap * 2;
            if (next > KO_MAX_LINE) next = KO_MAX_LINE;
            char* nb = (char*)realloc(buf, next);
            if (!nb) {
                free(buf);
                return -1;
            }
            buf = nb;
            cap = next;
        }
        buf[pos++] = ch;
    }
    buf[pos] = '\0';
    *out = buf;
    return 0;
}

static void json_escape_append(char* out, size_t cap, size_t* pos, const char* value)
{
    if (*pos >= cap) return;
    out[(*pos)++] = '"';
    const unsigned char* p = (const unsigned char*)(value ? value : "");
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

static int json_get_string(const char* json, const char* key, char* out, size_t cap)
{
    if (!json || !key || !out || cap < 2) return -1;
    out[0] = '\0';
    char pat[128];
    snprintf(pat, sizeof(pat), "\"%s\"", key);
    const char* p = strstr(json, pat);
    if (!p) return -1;
    p = strchr(p + strlen(pat), ':');
    if (!p) return -1;
    p++;
    while (*p && isspace((unsigned char)*p)) p++;
    if (*p != '"') return -1;
    p++;
    size_t w = 0;
    while (*p && *p != '"' && w + 1 < cap) {
        if (*p == '\\' && p[1]) {
            p++;
            if (*p == 'n') out[w++] = '\n';
            else if (*p == 'r') out[w++] = '\r';
            else if (*p == 't') out[w++] = '\t';
            else out[w++] = *p;
            p++;
            continue;
        }
        out[w++] = *p++;
    }
    out[w] = '\0';
    return w > 0 ? 0 : -1;
}

static int parse_hello_json(const char* line, KoClient* client)
{
    if (json_get_string(line, "user", client->username, sizeof(client->username)) != 0) return -1;
    if (json_get_string(line, "documentId", client->document_id, sizeof(client->document_id)) != 0) return -1;
    if (json_get_string(line, "path", client->kin_path, sizeof(client->kin_path)) != 0) return -1;
    if (json_get_string(line, "fileType", client->file_type, sizeof(client->file_type)) != 0)
        snprintf(client->file_type, sizeof(client->file_type), "docx");
    if (json_get_string(line, "sessionId", client->session_id, sizeof(client->session_id)) != 0)
        client->session_id[0] = '\0';
    return 0;
}

static KoRoom* room_find_or_create_locked(KoClient* client)
{
    for (KoRoom* r = g_rooms; r; r = r->next) {
        if (strcmp(r->document_id, client->document_id) == 0) return r;
    }
    KoRoom* r = (KoRoom*)calloc(1, sizeof(*r));
    if (!r) return NULL;
    snprintf(r->document_id, sizeof(r->document_id), "%s", client->document_id);
    snprintf(r->kin_path, sizeof(r->kin_path), "%s", client->kin_path);
    snprintf(r->file_type, sizeof(r->file_type), "%s", client->file_type);
    r->participants_timestamp = (unsigned long)ko_now_ms();
    r->next = g_rooms;
    g_rooms = r;
    return r;
}

static void room_broadcast_locked(KoRoom* room, KoClient* exclude, const char* line)
{
    if (!room || !line) return;
    for (KoClient* c = room->clients; c; c = c->next_in_room) {
        if (c == exclude) continue;
        (void)write_line(c->fd, line);
    }
}

static void client_connection_id(const KoClient* client, char* out, size_t cap)
{
    if (!client || !out || cap == 0) return;
    snprintf(out, cap, "%s%d", client->username, client->index_user);
}

static void append_participants_json(KoRoom* room, char* out, size_t cap, size_t* p)
{
    *p += (size_t)snprintf(out + *p, cap - *p, "[");
    int first = 1;
    for (KoClient* c = room->clients; c; c = c->next_in_room) {
        if (!first) *p += (size_t)snprintf(out + *p, cap - *p, ",");
        first = 0;
        char connection_id[KO_MAX_USER + 32];
        snprintf(connection_id, sizeof(connection_id), "%s%d", c->username, c->index_user);
        *p += (size_t)snprintf(out + *p, cap - *p, "{\"id\":");
        json_escape_append(out, cap, p, connection_id);
        *p += (size_t)snprintf(out + *p, cap - *p, ",\"idOriginal\":");
        json_escape_append(out, cap, p, c->username);
        *p += (size_t)snprintf(out + *p, cap - *p, ",\"username\":");
        json_escape_append(out, cap, p, c->username);
        *p += (size_t)snprintf(out + *p, cap - *p, ",\"firstname\":");
        json_escape_append(out, cap, p, c->username);
        *p += (size_t)snprintf(out + *p, cap - *p, ",\"lastname\":\"\",\"indexUser\":%d,\"view\":false}", c->index_user);
    }
    *p += (size_t)snprintf(out + *p, cap - *p, "]");
}

static void room_send_participants_locked(KoRoom* room)
{
    if (!room) return;
    room->participants_timestamp = (unsigned long)ko_now_ms();
    char msg[32768];
    size_t p = 0;
    p += (size_t)snprintf(msg + p, sizeof(msg) - p,
        "{\"type\":\"connectState\",\"waitAuth\":false,\"participantsTimestamp\":%lu,\"participants\":",
        room->participants_timestamp);
    append_participants_json(room, msg, sizeof(msg), &p);
    p += (size_t)snprintf(msg + p, sizeof(msg) - p, "}\n");
    room_broadcast_locked(room, NULL, msg);
}

static void room_join(KoClient* client)
{
    pthread_mutex_lock(&g_rooms_lock);
    KoRoom* room = room_find_or_create_locked(client);
    client->room = room;
    client->index_user = g_next_index_user++;
    if (room) {
        client->next_in_room = room->clients;
        room->clients = client;
    }
    pthread_mutex_unlock(&g_rooms_lock);
    fprintf(stderr, "kinoffice-collab: join user=%s document=%s path=%s index=%d\n",
        client->username, client->document_id, client->kin_path, client->index_user);
}

static void room_leave(KoClient* client)
{
    fprintf(stderr, "kinoffice-collab: leave user=%s document=%s\n", client->username, client->document_id);
    pthread_mutex_lock(&g_rooms_lock);
    KoRoom* room = client->room;
    if (room) {
        KoClient** pp = &room->clients;
        while (*pp) {
            if (*pp == client) {
                *pp = client->next_in_room;
                break;
            }
            pp = &(*pp)->next_in_room;
        }
        KoLock** lp = &room->locks;
        while (*lp) {
            if (strcmp((*lp)->user, client->username) == 0) {
                KoLock* dead = *lp;
                *lp = dead->next;
                free(dead);
                continue;
            }
            lp = &(*lp)->next;
        }
        room_send_participants_locked(room);
    }
    pthread_mutex_unlock(&g_rooms_lock);
}

static void handle_auth(KoClient* client)
{
    fprintf(stderr, "kinoffice-collab: auth user=%s document=%s\n", client->username, client->document_id);
    pthread_mutex_lock(&g_rooms_lock);
    KoRoom* room = client->room;
    char msg[32768];
    size_t p = 0;
    p += (size_t)snprintf(msg + p, sizeof(msg) - p, "{\"type\":\"auth\",\"result\":1,\"sessionId\":");
    json_escape_append(msg, sizeof(msg), &p, client->session_id[0] ? client->session_id : client->username);
    p += (size_t)snprintf(msg + p, sizeof(msg) - p,
        ",\"indexUser\":%d,\"sessionTimeConnect\":0,\"openedAt\":0,\"changesIndex\":%lu,\"syncChangesIndex\":%lu,"
        "\"settings\":{\"websocketMaxPayloadSize\":1572864,\"reconnection\":{\"attempts\":15,\"delay\":500}},"
        "\"license\":{},\"participants\":",
        client->index_user,
        room ? room->changes_index : 0,
        room ? room->changes_index : 0);
    if (room) append_participants_json(room, msg, sizeof(msg), &p);
    else p += (size_t)snprintf(msg + p, sizeof(msg) - p, "[]");
    p += (size_t)snprintf(msg + p, sizeof(msg) - p, "}\n");
    pthread_mutex_unlock(&g_rooms_lock);
    write_line(client->fd, msg);
}

static void handle_get_lock(KoClient* client, const char* line)
{
    char block[256];
    if (json_get_string(line, "block", block, sizeof(block)) != 0)
        snprintf(block, sizeof(block), "document");
    pthread_mutex_lock(&g_rooms_lock);
    KoRoom* room = client->room;
    int held = 0;
    if (room) {
        for (KoLock* l = room->locks; l; l = l->next) {
            if (strcmp(l->key, block) == 0 && strcmp(l->user, client->username) != 0) {
                held = 1;
                break;
            }
        }
        if (!held) {
            KoLock* l = (KoLock*)calloc(1, sizeof(*l));
            if (l) {
                snprintf(l->key, sizeof(l->key), "%s", block);
                snprintf(l->user, sizeof(l->user), "%s", client->username);
                l->next = room->locks;
                room->locks = l;
            }
        }
    }
    pthread_mutex_unlock(&g_rooms_lock);
    char msg[1024];
    snprintf(msg, sizeof(msg),
        held ? "{\"type\":\"getLock\",\"error\":\"Already locked\"}\n"
             : "{\"type\":\"getLock\",\"locks\":{\"document\":{\"user\":\"%s\",\"time\":%ld,\"block\":\"%s\"}}}\n",
        client->username, (long)time(NULL), block);
    write_line(client->fd, msg);
    if (!held && client->room) {
        pthread_mutex_lock(&g_rooms_lock);
        room_broadcast_locked(client->room, client, msg);
        pthread_mutex_unlock(&g_rooms_lock);
    }
}

static void handle_save_changes(KoClient* client, const char* line)
{
    char changes[KO_MAX_LINE];
    changes[0] = '\0';
    if (json_get_string(line, "changes", changes, sizeof(changes)) != 0) {
        return;
    }
    pthread_mutex_lock(&g_rooms_lock);
    unsigned long idx = 0;
    if (client->room) {
        client->room->changes_index++;
        idx = client->room->changes_index;
        fprintf(stderr, "kinoffice-collab: saveChanges user=%s document=%s index=%lu bytes=%zu\n",
            client->username, client->document_id, idx, strlen(changes));
        char user_id[KO_MAX_USER + 32];
        char msg[KO_MAX_LINE + 1024];
        size_t p = 0;
        client_connection_id(client, user_id, sizeof(user_id));
        p += (size_t)snprintf(msg + p, sizeof(msg) - p,
            "{\"type\":\"saveChanges\",\"changes\":[{\"change\":");
        json_escape_append(msg, sizeof(msg), &p, changes);
        p += (size_t)snprintf(msg + p, sizeof(msg) - p, ",\"user\":");
        json_escape_append(msg, sizeof(msg), &p, user_id);
        p += (size_t)snprintf(msg + p, sizeof(msg) - p, ",\"useridoriginal\":");
        json_escape_append(msg, sizeof(msg), &p, client->username);
        p += (size_t)snprintf(msg + p, sizeof(msg) - p,
            ",\"time\":%ld}],\"changesIndex\":%lu,\"syncChangesIndex\":%lu,\"endSaveChanges\":true}\n",
            (long)time(NULL), idx, idx);
        room_broadcast_locked(client->room, client, msg);
    }
    pthread_mutex_unlock(&g_rooms_lock);
    char ack[256];
    snprintf(ack, sizeof(ack), "{\"type\":\"unSaveLock\",\"index\":%lu,\"syncChangesIndex\":%lu,\"time\":%ld}\n", idx, idx, (long)time(NULL));
    write_line(client->fd, ack);
}

static void handle_cursor(KoClient* client, const char* line)
{
    char cursor[8192];
    char user_id[KO_MAX_USER + 32];
    char msg[10000];
    size_t p = 0;
    if (json_get_string(line, "cursor", cursor, sizeof(cursor)) != 0) return;
    fprintf(stderr, "kinoffice-collab: cursor user=%s document=%s bytes=%zu\n",
        client->username, client->document_id, strlen(cursor));
    client_connection_id(client, user_id, sizeof(user_id));
    p += (size_t)snprintf(msg + p, sizeof(msg) - p, "{\"type\":\"cursor\",\"messages\":[{\"cursor\":");
    json_escape_append(msg, sizeof(msg), &p, cursor);
    p += (size_t)snprintf(msg + p, sizeof(msg) - p, ",\"user\":");
    json_escape_append(msg, sizeof(msg), &p, user_id);
    p += (size_t)snprintf(msg + p, sizeof(msg) - p, ",\"useridoriginal\":");
    json_escape_append(msg, sizeof(msg), &p, client->username);
    p += (size_t)snprintf(msg + p, sizeof(msg) - p, "}]}\n");
    pthread_mutex_lock(&g_rooms_lock);
    if (client->room) room_broadcast_locked(client->room, client, msg);
    pthread_mutex_unlock(&g_rooms_lock);
}

static void handle_client_message(KoClient* client, const char* line)
{
    char type[64];
    if (json_get_string(line, "type", type, sizeof(type)) != 0) return;
    if (strcmp(type, "auth") == 0) {
        handle_auth(client);
        return;
    }
    if (strcmp(type, "getLock") == 0) {
        handle_get_lock(client, line);
        return;
    }
    if (strcmp(type, "isSaveLock") == 0) {
        write_line(client->fd, "{\"type\":\"saveLock\",\"saveLock\":false}\n");
        return;
    }
    if (strcmp(type, "saveChanges") == 0) {
        handle_save_changes(client, line);
        return;
    }
    if (strcmp(type, "cursor") == 0) {
        handle_cursor(client, line);
        return;
    }
    if (strcmp(type, "close") == 0) return;
    pthread_mutex_lock(&g_rooms_lock);
    if (client->room) room_broadcast_locked(client->room, client, line);
    pthread_mutex_unlock(&g_rooms_lock);
}

static void* client_thread(void* arg)
{
    int fd = *(int*)arg;
    free(arg);
    char* hello = NULL;
    if (read_line_dynamic(fd, &hello) != 0) {
        close(fd);
        return NULL;
    }
    KoClient* client = (KoClient*)calloc(1, sizeof(*client));
    if (!client || parse_hello_json(hello, client) != 0) {
        free(hello);
        free(client);
        close(fd);
        return NULL;
    }
    free(hello);
    client->fd = fd;
    room_join(client);
    pthread_mutex_lock(&g_rooms_lock);
    room_send_participants_locked(client->room);
    pthread_mutex_unlock(&g_rooms_lock);

    char* line = NULL;
    while (g_running && read_line_dynamic(fd, &line) == 0) {
        handle_client_message(client, line);
        free(line);
        line = NULL;
    }
    free(line);
    room_leave(client);
    close(fd);
    free(client);
    return NULL;
}

static int parse_port(const char* value)
{
    if (!value || !*value) return KO_DEFAULT_PORT;
    int port = atoi(value);
    return port > 0 && port <= 65535 ? port : KO_DEFAULT_PORT;
}

int main(int argc, char** argv)
{
    const char* host = getenv("KINOFFICE_COLLAB_HOST");
    const char* port_env = getenv("KINOFFICE_COLLAB_PORT");
    int port = parse_port(port_env);
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--host") == 0 && i + 1 < argc) host = argv[++i];
        else if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) port = parse_port(argv[++i]);
    }
    if (!host || !*host) host = KO_DEFAULT_HOST;

    signal(SIGTERM, handle_signal);
    signal(SIGINT, handle_signal);
    signal(SIGPIPE, SIG_IGN);

    int sfd = socket(AF_INET, SOCK_STREAM, 0);
    if (sfd < 0) {
        perror("socket");
        return 1;
    }
    int opt = 1;
    setsockopt(sfd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));
    struct sockaddr_in addr;
    memset(&addr, 0, sizeof(addr));
    addr.sin_family = AF_INET;
    addr.sin_port = htons((uint16_t)port);
    if (inet_pton(AF_INET, host, &addr.sin_addr) != 1) {
        fprintf(stderr, "kinoffice-collab: invalid host %s\n", host);
        close(sfd);
        return 1;
    }
    if (bind(sfd, (struct sockaddr*)&addr, sizeof(addr)) != 0 || listen(sfd, 64) != 0) {
        perror("bind/listen");
        close(sfd);
        return 1;
    }
    g_listener_fd = sfd;
    fprintf(stderr, "kinoffice-collab: listening on %s:%d\n", host, port);
    while (g_running) {
        int cfd = accept(sfd, NULL, NULL);
        if (cfd < 0) {
            if (errno == EINTR) continue;
            break;
        }
        int* pfd = (int*)malloc(sizeof(int));
        if (!pfd) {
            close(cfd);
            continue;
        }
        *pfd = cfd;
        pthread_t tid;
        if (pthread_create(&tid, NULL, client_thread, pfd) == 0)
            pthread_detach(tid);
        else {
            close(cfd);
            free(pfd);
        }
    }
    g_listener_fd = -1;
    close(sfd);
    return 0;
}
