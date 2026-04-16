import React from "react";
import { Box, Text, type BoxProps } from "ink";

interface MetricPanelProps {
  title: string;
  icon: string;
  borderColor: BoxProps["borderColor"];
  children: React.ReactNode;
}

export const MetricPanel: React.FC<MetricPanelProps> = ({
  title,
  icon,
  borderColor,
  children,
}) => {
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={borderColor}
      padding={1}
      flexGrow={1}
    >
      <Text bold>{icon} {title}</Text>
      <Box flexDirection="column" marginTop={1}>
        {children}
      </Box>
    </Box>
  );
};
