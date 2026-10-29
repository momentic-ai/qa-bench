export const MO_EFFORTS = ["low", "medium", "high", "max"] as const;
export type MoEffort = (typeof MO_EFFORTS)[number];
