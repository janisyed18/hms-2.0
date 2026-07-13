export const motionTokens = {
  duration: { fast: 0.16, normal: 0.24, slow: 0.36 },
  ease: {
    enter: [0.16, 1, 0.3, 1] as const,
    exit: [0.4, 0, 1, 1] as const
  },
  spring: {
    gentle: { type: "spring" as const, stiffness: 240, damping: 28 },
    snappy: { type: "spring" as const, stiffness: 420, damping: 34 }
  },
  distance: { page: 10, overlay: 14 }
} as const;
