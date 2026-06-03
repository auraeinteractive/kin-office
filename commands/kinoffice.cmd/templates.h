#ifndef KINOFFICE_TEMPLATES_H
#define KINOFFICE_TEMPLATES_H

#include <stddef.h>

typedef struct {
    const char* type;
    const char* b64;
    size_t raw_len;
} kinoffice_template_t;

extern const kinoffice_template_t KINOFFICE_TEMPLATES[];

#endif
