#include <vector>
#include "exactness.h"

namespace app {
    struct Point {
        int x;
        int y;
    };

    struct StructWidget {
        StructWidget();
        void render();
    };

    class Widget {
    public:
        Widget();
        void render();
    };

    class InlineWidget {
    public:
        InlineWidget() {}
        void inlineRender() {}
    };

    enum class Color { Red, Green };

    class Duplicate {
    public:
        void first();
    };

    class Duplicate {
    public:
        void second();
    };

    void freeFunction() {}
}
