import { G, Path, Svg } from "react-native-svg"

// Line icons on a 24 px grid. The icon font is not bundled, so each glyph is a few strokes.
const PATHS = {
  search: ["M11 4a7 7 0 1 0 0 14a7 7 0 0 0 0-14z", "M20 20l-4-4"],
  plus: ["M12 5v14", "M5 12h14"],
  close: ["M6 6l12 12", "M18 6L6 18"],
  chevronDown: ["M6 9l6 6l6-6"],
  chevronUp: ["M6 15l6-6l6 6"],
  chevronRight: ["M9 6l6 6l-6 6"],
  chevronLeft: ["M15 6l-6 6l6 6"],
  more: ["M5 12h.01", "M12 12h.01", "M19 12h.01"],
  paperclip: ["M20 11l-8 8a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7-7"],
  mic: ["M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z", "M6 11a6 6 0 0 0 12 0", "M12 17v4"],
  send: ["M4 12l16-8l-6 16l-3-7z"],
  gear: [
    "M12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z",
    "M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1",
  ],
  folder: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"],
  terminal: ["M5 7l5 5l-5 5", "M12 18h7"],
  sparkle: ["M12 3l2 6l6 3l-6 3l-2 6l-2-6l-6-3l6-3z"],
  shield: ["M12 3l8 3v6c0 5-4 8-8 9c-4-1-8-4-8-9V6z"],
  file: ["M7 3h7l5 5v13H7z", "M14 3v5h5"],
  branch: ["M7 4v12", "M17 8a2 2 0 1 0 0 .01", "M7 20a2 2 0 1 0 0 .01", "M17 10c0 4-5 4-10 6"],
  github: [
    "M9 19c-4 1.5-4-2-6-2.5M15 21v-3.5c0-1 .1-1.5-.5-2.5c3-.3 6-1.5 6-6.5a5 5 0 0 0-1.4-3.5a4.6 4.6 0 0 0-.1-3.5s-1.1-.3-3.6 1.3a12 12 0 0 0-6.8 0C6.1 2.8 5 3.1 5 3.1a4.6 4.6 0 0 0-.1 3.5A5 5 0 0 0 3.5 10c0 5 3 6.2 6 6.5c-.6 1-.5 1.500-.5 2.500V21",
  ],
  figma: [
    "M8 3h4a3 3 0 0 1 0 6H8z",
    "M12 3h4a3 3 0 0 1 0 6h-4z",
    "M8 9h4v6H8a3 3 0 0 1 0-6z",
    "M12 15a3 3 0 1 0 3-3a3 3 0 0 0-3 3z",
    "M8 15h4v3a3 3 0 0 1-4 3z",
  ],
  book: ["M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z", "M5 17a3 3 0 0 1 3-3h11"],
  board: ["M4 5h16v14H4z", "M10 5v14", "M16 5v14"],
  check: ["M5 12l5 5l9-10"],
  undo: ["M9 5L4 10l5 5", "M4 10h10a6 6 0 0 1 0 12H9"],
  link: [
    "M10 14a4 4 0 0 0 5.600 0l3-3a4 4 0 0 0-5.600-5.600L12 7",
    "M14 10a4 4 0 0 0-5.600 0l-3 3a4 4 0 0 0 5.600 5.600L12 17",
  ],
} as const

export type IconName = keyof typeof PATHS

export interface IconProps {
  readonly name: IconName
  readonly size?: number
  readonly color: string
  readonly strokeWidth?: number
}

// Decorative: the button that holds an icon carries the accessible label.
export function Icon({ name, size = 20, color, strokeWidth = 1.8 }: IconProps) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <G fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        {PATHS[name].map((d) => (
          <Path key={d} d={d} />
        ))}
      </G>
    </Svg>
  )
}
