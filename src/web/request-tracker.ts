export interface LatestRequestTracker {
  begin(): number;
  isCurrent(token: number): boolean;
}

export function createLatestRequestTracker(): LatestRequestTracker {
  let latestToken = 0;

  return {
    begin(): number {
      latestToken += 1;
      return latestToken;
    },
    isCurrent(token: number): boolean {
      return token === latestToken;
    },
  };
}
