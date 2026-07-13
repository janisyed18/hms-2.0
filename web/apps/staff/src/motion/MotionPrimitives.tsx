import type { LucideIcon } from "lucide-react";
import {
  Children,
  Fragment,
  isValidElement,
  type JSX,
  type ReactElement,
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

export type PressableContent =
  | string
  | number
  | boolean
  | null
  | undefined
  | ReactElement<NativeContentProps, keyof JSX.IntrinsicElements | typeof Fragment>
  | readonly PressableContent[];

export type PressableProps = Omit<HTMLMotionProps<"button">, "children"> & {
  children?: PressableContent;
  icon?: LucideIcon;
};

const instantTransition = { duration: 0 } as const;
const staggerDelay = 0.06;
const interactiveTags = new Set([
  "a",
  "audio",
  "button",
  "details",
  "embed",
  "iframe",
  "input",
  "object",
  "select",
  "summary",
  "textarea",
  "video"
]);
const interactiveRoles = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox"
]);
const pressableContentError =
  "Pressable only accepts non-interactive content; nested native controls are unsupported.";
const customPressableContentError =
  "Pressable custom component children are unsupported; use the icon prop for Lucide icons.";

type NativeContentProps = {
  children?: PressableContent;
  contentEditable?: boolean | "inherit" | "plaintext-only" | "true" | "false";
  onClick?: unknown;
  onKeyDown?: unknown;
  onKeyUp?: unknown;
  onPointerDown?: unknown;
  role?: string;
  tabIndex?: number;
};

function assertNonInteractiveNativeContent(children: ReactNode): void {
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;

    const props = child.props as NativeContentProps;
    if (child.type === Fragment) {
      assertNonInteractiveNativeContent(props.children);
      return;
    }

    const hasInteractiveProps =
      props.contentEditable === true ||
      props.contentEditable === "true" ||
      (typeof props.tabIndex === "number" && props.tabIndex >= 0) ||
      (typeof props.role === "string" && interactiveRoles.has(props.role)) ||
      props.onClick !== undefined ||
      props.onKeyDown !== undefined ||
      props.onKeyUp !== undefined ||
      props.onPointerDown !== undefined;

    if (typeof child.type !== "string") {
      throw new Error(customPressableContentError);
    }

    if (interactiveTags.has(child.type) || hasInteractiveProps) {
      throw new Error(pressableContentError);
    }

    assertNonInteractiveNativeContent(props.children);
  });
}

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
  icon: Icon,
  onClick,
  type = "button",
  ...props
}: PressableProps) {
  const reducedMotion = useReducedMotion();
  assertNonInteractiveNativeContent(children);

  return (
    <m.button
      {...props}
      className={className}
      onClick={onClick}
      type={type}
      whileTap={reducedMotion ? undefined : { scale: 0.98 }}
      transition={motionTokens.spring.snappy}
    >
      {Icon ? <Icon aria-hidden="true" /> : null}
      {children}
    </m.button>
  );
}
