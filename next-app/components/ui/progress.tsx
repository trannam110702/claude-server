"use client";

// Ported from shadcn/ui's Base UI Progress (apps/v4/registry/bases/base/ui/progress.tsx).
// Source: https://ui.shadcn.com/docs/components/base/progress
// We inline the styles that shadcn's `cn-progress-*` utility classes expand to,
// so the component is self-contained and doesn't require a separate CSS layer.

import { Progress as ProgressPrimitive } from "@base-ui/react/progress";
import { cn } from "@/lib/utils";

function Progress({
  className,
  children,
  value,
  ...props
}: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      value={value}
      data-slot="progress"
      className={cn("flex flex-wrap items-center gap-x-3 gap-y-1.5", className)}
      {...props}
    >
      {children}
      {/* If no Track is provided as a child, render a default one so
          `<Progress value={...} />` works as a one-liner like shadcn shows. */}
      <ProgressTrack>
        <ProgressIndicator />
      </ProgressTrack>
    </ProgressPrimitive.Root>
  );
}

function ProgressTrack({
  className,
  ...props
}: ProgressPrimitive.Track.Props) {
  return (
    <ProgressPrimitive.Track
      data-slot="progress-track"
      className={cn(
        "relative flex h-2 w-full items-center overflow-x-hidden rounded-full bg-muted",
        className
      )}
      {...props}
    />
  );
}

function ProgressIndicator({
  className,
  ...props
}: ProgressPrimitive.Indicator.Props) {
  return (
    <ProgressPrimitive.Indicator
      data-slot="progress-indicator"
      className={cn("h-full bg-primary transition-all", className)}
      {...props}
    />
  );
}

function ProgressLabel({
  className,
  ...props
}: ProgressPrimitive.Label.Props) {
  return (
    <ProgressPrimitive.Label
      data-slot="progress-label"
      className={cn("text-sm font-medium", className)}
      {...props}
    />
  );
}

function ProgressValue({
  className,
  ...props
}: ProgressPrimitive.Value.Props) {
  return (
    <ProgressPrimitive.Value
      data-slot="progress-value"
      className={cn("ml-auto text-sm tabular-nums text-muted-foreground", className)}
      {...props}
    />
  );
}

export {
  Progress,
  ProgressTrack,
  ProgressIndicator,
  ProgressLabel,
  ProgressValue,
};
