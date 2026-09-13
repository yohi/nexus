mod outer {
    pub struct Point {
        x: f64,
        y: f64,
    }

    pub enum Color {
        Red,
        Green,
    }

    impl Point {
        pub fn new(x: f64, y: f64) -> Self {
            Point { x, y }
        }
    }

    impl Point {
        pub fn new(x: f64, y: f64) -> Self {
            Point { x, y }
        }
    }

    pub trait Drawable {
        fn draw(&self);
    }

    pub struct Duplicate {
        first: i32,
    }

    pub struct Duplicate {
        second: i32,
    }

    mod nested {
        pub struct Marker;
    }
}

pub fn top_level() {}

use std::fs::File;
use std::io::*;
