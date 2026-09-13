using System;
using static System.Math;

namespace MyApp
{
    public class Exactness
    {
        public struct Point
        {
            public int X { get; set; }
        }

        public interface IDrawable
        {
            void Draw();
        }

        public enum Color { Red, Green }

        public record Person(string Name);

        public Exactness() {}

        public void Method() {}
    }
}
