/// <reference path="../../assets.d.ts" />
import { Image, Text, View } from "react-native"
import { Path, Rect, Svg } from "react-native-svg"
import guia from "../../assets/guia.png"
import { tokens } from "../../theme.js"
import { avatarColorFor, initialsOf } from "./avatar-color.js"

export interface AvatarProps {
  // A Bot id: picks the colour. Ignored by the human and Guide variants.
  readonly id: string
  readonly size?: number
}

// The flat version of the robot: a rounded square in the Bot's colour with the dark visor, two eyes and a smile.
export function Avatar({ id, size = 44 }: AvatarProps) {
  const fill = avatarColorFor(id)
  const light = fill === tokens.avatarPalette[7]
  const visor = light ? tokens.color.red : tokens.color.background
  return (
    <View style={{ width: size, height: size }}>
      <Svg width={size} height={size} viewBox="0 0 48 48" aria-hidden>
        <Rect x={0} y={0} width={48} height={48} rx={12} fill={fill} />
        <Rect x={8} y={12} width={32} height={24} rx={9} fill={visor} />
        <Rect x={16} y={19} width={4} height={8} rx={2} fill={tokens.color.white} />
        <Rect x={28} y={19} width={4} height={8} rx={2} fill={tokens.color.white} />
        <Path
          d="M20 30c2 2 6 2 8 0"
          stroke={tokens.color.white}
          strokeWidth={2}
          strokeLinecap="round"
          fill="none"
        />
      </Svg>
    </View>
  )
}

export interface HumanAvatarProps {
  readonly name: string
  readonly size?: number
}

// The operator: a ring with initials (the `RW` of the reference).
export function HumanAvatar({ name, size = 44 }: HumanAvatarProps) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 2,
        borderColor: tokens.color.textSecondary,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <Text style={{ color: tokens.color.text, fontSize: size * 0.34, fontWeight: "600" }}>
        {initialsOf(name)}
      </Text>
    </View>
  )
}

export interface GuideAvatarProps {
  readonly size?: number
}

// The 3D Guide, used for the hero of the sidebar.
export function GuideAvatar({ size = 120 }: GuideAvatarProps) {
  return <Image source={guia} accessibilityIgnoresInvertColors style={{ width: size, height: size }} />
}
