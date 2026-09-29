import React from "react";
import { Box, Text, useInput } from "ink";

const VIEWS = ["1 Overview", "2 Index", "3 Retrieval", "4 Provider", "5 Diagnostics"] as const;

export interface NavigationProps {
  readonly activeIndex: number;
  readonly onChange: (index: number) => void;
}

export const Navigation: React.FC<NavigationProps> = ({ activeIndex, onChange }) => {
  useInput(
    (input, key) => {
      const numericIndex = Number(input) - 1;
      if (Number.isInteger(numericIndex) && numericIndex >= 0 && numericIndex < VIEWS.length) {
        onChange(numericIndex);
      } else if (key.shift && key.tab) {
        onChange((activeIndex + VIEWS.length - 1) % VIEWS.length);
      } else if (key.tab || key.rightArrow) {
        onChange((activeIndex + 1) % VIEWS.length);
      } else if (key.leftArrow) {
        onChange((activeIndex + VIEWS.length - 1) % VIEWS.length);
      }
    },
    { isActive: process.stdin.isTTY === true },
  );
  return <Box justifyContent="space-around" marginBottom={1}>
    {VIEWS.map((label, index) => (
      <Text key={label} bold={index === activeIndex} color={index === activeIndex ? "cyan" : undefined}>
        {label}
      </Text>
    ))}
  </Box>;
};
