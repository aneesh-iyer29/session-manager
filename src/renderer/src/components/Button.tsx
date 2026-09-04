import { motion, type HTMLMotionProps } from 'motion/react'
import { tap } from '../lib/motion'

type Variant = 'default' | 'primary' | 'quiet' | 'danger'

interface Props extends Omit<HTMLMotionProps<'button'>, 'ref'> {
  variant?: Variant
  size?: 'md' | 'sm'
  /** Marks the second, confirming press of a destructive action. */
  confirming?: boolean
}

/** Press feedback is the only decoration a button gets: scale 0.97 while held. */
export function Button({ variant = 'default', size = 'md', confirming = false, className = '', type = 'button', ...rest }: Props) {
  const classes = [
    'btn',
    variant !== 'default' ? `btn--${variant}` : '',
    size === 'sm' ? 'btn--sm' : '',
    confirming ? 'btn--confirm' : '',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  return <motion.button type={type} className={classes} whileTap={rest.disabled ? undefined : tap} {...rest} />
}
