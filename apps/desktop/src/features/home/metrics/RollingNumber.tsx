import { useEffect, useState } from "react";
import NumberFlow, { type Format } from "@number-flow/react";

type AnimationKey = string | number;

type RollingNumberProps = {
  value: number;
  animationKey?: AnimationKey;
  className?: string;
  format?: Format;
  prefix?: string;
  suffix?: string;
  title?: string;
};

export function RollingNumber({ animationKey = 0, ...props }: RollingNumberProps) {
  return <AnimatedNumber key={animationKey} {...props} />;
}

function AnimatedNumber({ value, className, format, prefix, suffix, title }: Omit<RollingNumberProps, "animationKey">) {
  const [started, setStarted] = useState(false);

  useEffect(() => {
    const frame = requestAnimationFrame(() => setStarted(true));
    return () => cancelAnimationFrame(frame);
  }, []);

  return <NumberFlow
    className={className}
    title={title}
    value={started ? value : 0}
    locales="en-US"
    format={format}
    prefix={prefix}
    suffix={suffix}
    respectMotionPreference={false}
    spinTiming={{ duration: 1_400, easing: "ease-out" }}
  />;
}
