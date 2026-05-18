/* exception_bp.c — fixture that triggers an access violation.
 * Used to test D3 exception-BP coalescing: a software BP set by the user at this
 * function's entry point fires as an exception + BP pair, coalesced into one event. */
#include <windows.h>
#include <stdio.h>

static volatile int sink = 0;

int cause_av(void) {
    volatile int *p = (volatile int *)0x1;
    return *p; /* access violation — will be caught by debugger */
}

int main(void) {
    sink = cause_av();
    return 0;
}
