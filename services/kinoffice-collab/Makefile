CC = gcc
CFLAGS = -Wall -g -pthread
EXTRA_CFLAGS ?=
CFLAGS += $(EXTRA_CFLAGS)
LDFLAGS = -pthread
TARGET = kinoffice-collab.service

all: $(TARGET)

$(TARGET): service.o
	$(CC) -o $@ $^ $(LDFLAGS)

service.o: service.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f *.o $(TARGET)

.PHONY: all clean
