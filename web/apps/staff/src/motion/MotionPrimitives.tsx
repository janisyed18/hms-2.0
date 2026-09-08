import type { ReactNode } from "react";
import { AnimatePresence, m, useReducedMotion } from "motion/react";

import { motionTokens } from "./motionTokens";

type MotionChildrenProps = {
  children: ReactNode;
  className?: string;
};

const instantTransition = { duration: 0 } as const;
const staggerDelay = 0.06;

function enterTransition(reducedMotion: boolean | null) {
  return reducedMotion
    ? instantTransition
    : { duration: motionTokens.duration.normal, ease: motionTokens.ease.enter };
}

function exitTransition(reducedMotion: boolean | null) {
  return reducedMotion
    ? instantTransition
    : { duration: motionTokens.duration.fast, ease: motionTokens.ease.exit };
}

export function PageMotion({
  children,
  motionKey,
  className
}: MotionChildrenProps & { motionKey?: string }) {
  const reducedMotion = useReducedMotion();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.section
        key={motionKey ?? "page"}
        className={className}
        initial={reducedMotion
          ? { opacity: 0 }
          : { opacity: 0, y: motionTokens.distance.page }}
        animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
        exit={reducedMotion
          ? { opacity: 0, transition: exitTransition(reducedMotion) }
          : {
              opacity: 0,
              y: -motionTokens.distance.page,
              transition: exitTransition(reducedMotion)
            }}
        transition={enterTransition(reducedMotion)}
      >
        {children}
      </m.section>
    </AnimatePresence>
  );
}

export function StaggerGroup({ children, className }: MotionChildrenProps) {
  const reducedMotion = useReducedMotion();
  const variants = {
    hidden: {},
    visible: {
      transition: { staggerChildren: reducedMotion ? 0 : staggerDelay }
    }
  };

  return (
    <m.div
      className={className}
      initial="hidden"
      animate="visible"
      variants={variants}
    >
      {children}
    </m.div>
  );
}

export function StaggerItem({ children, className }: MotionChildrenProps) {
  const reducedMotion = useReducedMotion();

  return (
    <m.div
      className={className}
      variants={{
        hidden: reducedMotion
          ? { opacity: 0 }
          : { opacity: 0, y: motionTokens.distance.page },
        visible: reducedMotion
          ? { opacity: 1, transition: instantTransition }
          : { opacity: 1, y: 0, transition: motionTokens.spring.gentle }
      }}
    >
      {children}
    </m.div>
  );
}

export function PresencePanel({
  children,
  presenceKey,
  className
}: MotionChildrenProps & { presenceKey: string }) {
  const reducedMotion = useReducedMotion();

  return (
    <AnimatePresence mode="wait" initial={false}>
      <m.div
        key={presenceKey}
        className={className}
        initial={false}
        animate={reducedMotion ? { opacity: 1 } : { opacity: 1, y: 0 }}
        exit={reducedMotion
          ? { opacity: 0, transition: exitTransition(reducedMotion) }
          : {
              opacity: 0,
              y: motionTokens.distance.overlay,
              transition: exitTransition(reducedMotion)
            }}
        transition={enterTransition(reducedMotion)}
      >
        {children}
      </m.div>
    </AnimatePresence>
  );
}
