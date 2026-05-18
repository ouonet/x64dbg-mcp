/* int3.c — fixture that executes a hardcoded INT3 breakpoint then exits.
 * Used to test D3 classification rule: hardcoded int3 (no user BP at address). */
#include <windows.h>

int main(void) {
    __debugbreak(); /* compiles to `int 3` — not a user-set BP */
    return 0;
}
