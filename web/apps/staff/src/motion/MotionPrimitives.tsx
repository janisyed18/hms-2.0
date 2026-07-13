import {
  Children,
  isValidElement,
  type ReactElement,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from "react";
import {
  AnimatePresence,
  m,
  useReducedMotion,
  type HTMLMotionProps
} from "motion/react";

import { motionTokens } from "./motionTokens";

type MotionChildrenProps = {
  children: ReactNode;
  className?: string;
};

type PressableProps = Omit<HTMLMotionProps<"button">, "children"> & {
  children: ReactNode;
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
    <m.section
      key={motionKey}
      className={className}
      initial={reducedMotion ? { opacity: 0 } : { opacity: 0, y: motionTokens.distance.page }}
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
        initial={reducedMotion
          ? { opacity: 0 }
          : { opacity: 0, y: motionTokens.distance.overlay }}
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

export function Pressable({
  children,
  className,
  onClick,
  type = "button",
  ...props
}: PressableProps) {
  const reducedMotion = useReducedMotion();
  const onlyChild = Children.count(children) === 1 && isValidElement(children)
    ? children as ReactElement
    : null;

  if (onlyChild?.type === "button") {
    const button = onlyChild as ReactElement<HTMLMotionProps<"button">>;
    const {
      children: buttonChildren,
      className: childClassName,
      onClick: childOnClick,
      type: childType,
      ...childProps
    } = button.props;

    return (
      <m.button
        {...childProps}
        {...props}
        className={[childClassName, className].filter(Boolean).join(" ") || undefined}
        onClick={onClick ?? childOnClick}
        type={childType ?? type}
        whileTap={reducedMotion ? undefined : { scale: 0.98 }}
        transition={motionTokens.spring.snappy}
      >
        {buttonChildren}
      </m.button>
    );
  }

  if (onlyChild?.type === "a") {
    const link = onlyChild as ReactElement<HTMLMotionProps<"a">>;
    const {
      children: linkChildren,
      className: childClassName,
      onClick: childOnClick,
      ...linkProps
    } = link.props;

    const handleClick = (event: ReactMouseEvent<HTMLAnchorElement>) => {
      childOnClick?.(event);
      if (!event.defaultPrevented) {
        onClick?.(event as unknown as ReactMouseEvent<HTMLButtonElement>);
      }
    };

    return (
      <m.a
        {...linkProps}
        className={[childClassName, className].filter(Boolean).join(" ") || undefined}
        onClick={handleClick}
        whileTap={reducedMotion ? undefined : { scale: 0.98 }}
        transition={motionTokens.spring.snappy}
      >
        {linkChildren}
      </m.a>
    );
  }

  return (
    <m.button
      {...props}
      className={className}
      onClick={onClick}
      type={type}
      whileTap={reducedMotion ? undefined : { scale: 0.98 }}
      transition={motionTokens.spring.snappy}
    >
      {children}
    </m.button>
  );
}
