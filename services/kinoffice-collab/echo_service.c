#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <netinet/in.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#define KO_ECHO_DEFAULT_HOST "127.0.0.1"
#define KO_ECHO_DEFAULT_PORT 19130

static volatile int g_running = 1;
static volatile int g_listener_fd = -1;

static void handle_signal(int sig)
{
    (void)sig;
    g_running = 0;
    if (g_listener_fd >= 0) close(g_listener_fd);
}

static int write_all(int fd, const void* buf, size_t n)
{
    const char* p = (const char*)buf;
    size_t off = 0;
    while (off < n) {
        ssize_t w = write(fd, p + off, n - off);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return -1;
        off += (size_t)w;
    }
    return 0;
}

static void* client_thread(void* arg)
{
    int fd = *(int*)arg;
    free(arg);
    char buf[4096];
    fprintf(stderr, "kinoffice-collab-echo: client connected\n");
    while (g_running) {
        ssize_t n = read(fd, buf, sizeof(buf));
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) break;
        fprintf(stderr, "kinoffice-collab-echo: received %zd byte(s)\n", n);
        if (write_all(fd, buf, (size_t)n) != 0) break;
    }
    close(fd);
    fprintf(stderr, "kinoffice-collab-echo: client disconnected\n");
    return NULL;
}

static int parse_port(const char* value)
{
    if (!value || !*value) return KO_ECHO_DEFAULT_PORT;
    int port = atoi(value);
    return port > 0 && port <= 65535 ? port : KO_ECHO_DEFAULT_PORT;
}

int main(int argc, char** argv)
{
    const char* host = getenv("KINOFFICE_COLLAB_ECHO_HOST");
    const char* port_env = getenv("KINOFFICE_COLLAB_ECHO_PORT");
    int port = parse_port(port_env);
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--host") == 0 && i + 1 < argc) host = argv[++i];
        else if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) port = parse_port(argv[++i]);
    }
    if (!host || !*host) host = KO_ECHO_DEFAULT_HOST;

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
        fprintf(stderr, "kinoffice-collab-echo: invalid host %s\n", host);
        close(sfd);
        return 1;
    }
    if (bind(sfd, (struct sockaddr*)&addr, sizeof(addr)) != 0 || listen(sfd, 16) != 0) {
        perror("bind/listen");
        close(sfd);
        return 1;
    }
    g_listener_fd = sfd;
    fprintf(stderr, "kinoffice-collab-echo: listening on %s:%d\n", host, port);
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
        if (pthread_create(&tid, NULL, client_thread, pfd) == 0) {
            pthread_detach(tid);
        } else {
            close(cfd);
            free(pfd);
        }
    }
    g_listener_fd = -1;
    close(sfd);
    return 0;
}
