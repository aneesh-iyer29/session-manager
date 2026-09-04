/**
 * The one spring the whole app uses (critically damped, per the brief) so
 * every movement feels like the same material. Components import this rather
 * than inventing their own curves.
 */
import type { Transition } from 'motion/react'

export const spring: Transition = { type: 'spring', bounce: 0, duration: 0.4 }

export const fade: Transition = { duration: 0.15 }

export const tap = { scale: 0.97 }
