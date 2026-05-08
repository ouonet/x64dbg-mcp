/* http_server.c — minimal Winsock TCP echo server for integration test.
 * Listens on 127.0.0.1:18080, accepts ONE connection, echoes "PONG\r\n", exits. */
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>

#pragma comment(lib, "ws2_32.lib")

int main(void) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

    SOCKET srv = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (srv == INVALID_SOCKET) { WSACleanup(); return 2; }

    BOOL yes = TRUE;
    setsockopt(srv, SOL_SOCKET, SO_REUSEADDR, (const char*)&yes, sizeof(yes));

    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = htons(18080);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

    if (bind(srv, (struct sockaddr*)&addr, sizeof(addr)) != 0) { closesocket(srv); WSACleanup(); return 3; }
    if (listen(srv, 1) != 0) { closesocket(srv); WSACleanup(); return 4; }

    SOCKET cli = accept(srv, NULL, NULL);
    if (cli == INVALID_SOCKET) { closesocket(srv); WSACleanup(); return 5; }

    char buf[256];
    int n = recv(cli, buf, sizeof(buf) - 1, 0);
    if (n <= 0) { closesocket(cli); closesocket(srv); WSACleanup(); return 6; }

    const char* reply = "PONG\r\n";
    send(cli, reply, (int)strlen(reply), 0);

    closesocket(cli);
    closesocket(srv);
    WSACleanup();
    return 0;
}
