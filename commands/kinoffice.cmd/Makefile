KIN_ROOT ?= ../../kin

CC = gcc
CFLAGS = -Wall -g
LDFLAGS =

TARGET = kinoffice
SOURCES = main.c templates.c
OBJECTS = $(SOURCES:.c=.o)

all: $(TARGET)

$(TARGET): $(OBJECTS)
	$(CC) -o $@ $^ $(LDFLAGS)

%.o: %.c
	$(CC) $(CFLAGS) -c $< -o $@

clean:
	rm -f $(OBJECTS) $(TARGET)

.PHONY: all clean
