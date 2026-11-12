import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "md" | "sm";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: ReactNode;
}

const base =
  "inline-flex items-center justify-center gap-2 rounded font-medium whitespace-nowrap select-none t-fast active:scale-[0.97] disabled:opacity-40 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-accent-on hover:bg-accent-hi",
  secondary: "bg-surface-2 text-fg-1 border border-line-strong hover:bg-surface-3",
  ghost: "text-fg-2 hover:bg-surface-3 hover:text-fg-1",
  danger: "bg-surface-2 text-danger border border-line-strong hover:bg-surface-3",
};

const sizes: Record<Size, string> = {
  md: "h-8 px-3 text-body",
  sm: "h-7 px-2.5 text-meta",
};

export const Button = forwardRef<HTMLButtonElement, Props>(function Button(
  { variant = "secondary", size = "md", icon, className = "", children, type = "button", ...rest },
  ref,
) {
  return (
    <button ref={ref} type={type} className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...rest}>
      {icon}
      {children}
    </button>
  );
});

interface IconProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  size?: Size;
  active?: boolean;
}

export const IconButton = forwardRef<HTMLButtonElement, IconProps>(function IconButton(
  { size = "md", active, className = "", type = "button", ...rest },
  ref,
) {
  const dim = size === "md" ? "h-8 w-8" : "h-7 w-7";
  return (
    <button
      ref={ref}
      type={type}
      className={`${dim} inline-flex items-center justify-center rounded text-fg-2 hover:bg-surface-3 hover:text-fg-1 t-fast active:scale-90 disabled:opacity-40 disabled:pointer-events-none ${
        active ? "bg-surface-3 text-fg-1" : ""
      } ${className}`}
      {...rest}
    />
  );
});
