CC = gcc
CFLAGS = -Wall -g -pthread
EXTRA_CFLAGS ?=
CFLAGS += $(EXTRA_CFLAGS)
LDFLAGS = -pthread
TARGET = kinoffice-collab.service
ECHO_TARGET = kinoffice-collab-echo.service

all: $(TARGET) $(ECHO_TARGET)

$(TARGET): service.o
	$(CC) -o $@ $^ $(LDFLAGS)

$(ECHO_TARGET): echo_service.o
	$(CC) -o $@ $^ $(LDFLAGS)

service.o: service.c
	$(CC) $(CFLAGS) -c $< -o $@

echo_service.o: echo_service.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f *.o $(TARGET) $(ECHO_TARGET)

.PHONY: all clean
