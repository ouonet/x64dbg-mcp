cmake_minimum_required(VERSION 3.15)
project(x64dbg_mcp_fixtures C)

set(CMAKE_C_STANDARD 99)

add_executable(http_server http_server.c)
target_link_libraries(http_server PRIVATE ws2_32)

add_executable(http_client http_client.c)
target_link_libraries(http_client PRIVATE ws2_32)
