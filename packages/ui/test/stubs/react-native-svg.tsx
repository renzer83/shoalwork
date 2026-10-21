import type { ReactNode, SVGAttributes } from "react"

// Test double for react-native-svg: its primitives become the SVG elements they stand for, so the tests can read
// the drawn attributes. The real package is only type-checked against, never loaded, under vitest.
interface PrimitiveProps extends SVGAttributes<SVGElement> {
  readonly children?: ReactNode
}

export const Svg = (props: PrimitiveProps) => <svg {...props} />
export const G = (props: PrimitiveProps) => <g {...props} />
export const Rect = (props: PrimitiveProps) => <rect {...props} />
export const Path = (props: PrimitiveProps) => <path {...props} />
export const Text = (props: PrimitiveProps) => <text {...props} />
