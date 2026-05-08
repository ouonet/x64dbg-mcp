/* http_client.c — minimal Winsock TCP client.
 * Connects to 127.0.0.1:18080, sends "PING\r\n", reads response, exits 0 on PONG. */
#include <winsock2.h>
#include <ws2tcpip.h>
#include <stdio.h>
#include <string.h>

#pragma comment(lib, "ws2_32.lib")

int main(void) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 1;

    SOCKET sock = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
    if (sock == INVALID_SOCKET) { WSACleanup(); return 2; }

    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_port = htons(18080);
    inet_pton(AF_INET, "127.0.0.1", &addr.sin_addr);

    if (connect(sock, (struct sockaddr*)&addr, sizeof(addr)) != 0) {
        closesocket(sock); WSACleanup(); return 3;
    }

    const char* msg = "PING\r\n";
    if (send(sock, msg, (int)strlen(msg), 0) <= 0) { closesocket(sock); WSACleanup(); return 4; }

    char buf[256];
    int n = recv(sock, buf, sizeof(buf) - 1, 0);
    if (n <= 0) { closesocket(sock); WSACleanup(); return 5; }
    buf[n] = 0;

    closesocket(sock);
    WSACleanup();
    return strstr(buf, "PONG") ? 0 : 6;
}
