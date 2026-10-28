type NavigatorInfo = Pick<Navigator, "userAgent"> &
  Partial<Pick<Navigator, "platform" | "maxTouchPoints">>;

const IOS_UNREPORTED_OUTPUT_LATENCY_MS = 55;

function getNavigatorInfo(): NavigatorInfo | undefined {
  return typeof navigator === "undefined" ? undefined : navigator;
}

// Keep detection local because importing helpers from index.ts would create a cycle.
function isIOS(navigatorInfo: NavigatorInfo): boolean {
  return (
    /iPad|iPhone|iPod/i.test(navigatorInfo.userAgent) ||
    (navigatorInfo.platform === "MacIntel" &&
      (navigatorInfo.maxTouchPoints ?? 0) > 1)
  );
}

// All iOS browsers use WebKit, while on macOS only Safari does.
export function reportsContextTimeAtRenderPosition(
  navigatorInfo: NavigatorInfo | undefined = getNavigatorInfo(),
): boolean {
  if (!navigatorInfo) return false;
  if (isIOS(navigatorInfo)) return true;

  const { userAgent } = navigatorInfo;
  return (
    /Macintosh/i.test(userAgent) &&
    /AppleWebKit/i.test(userAgent) &&
    /Safari/i.test(userAgent) &&
    !/Chrome|Chromium|Edg|OPR|Firefox/i.test(userAgent)
  );
}

export function getUnreportedOutputLatencyMs(
  navigatorInfo: NavigatorInfo | undefined = getNavigatorInfo(),
): number {
  return navigatorInfo && isIOS(navigatorInfo)
    ? IOS_UNREPORTED_OUTPUT_LATENCY_MS
    : 0;
}
