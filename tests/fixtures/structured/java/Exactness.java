package com.example;

import java.util.List;
import java.util.*;

public class Exactness {
    public record Point(int x, int y) {}

    public interface Drawable {
        void draw();
    }

    public enum Color {
        RED, GREEN
    }

    private int field;

    public Exactness() {}

    public void method() {}
}
