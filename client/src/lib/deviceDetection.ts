// Device detection utilities

export function isAndroid(): boolean {
  const userAgent = navigator.userAgent.toLowerCase();
  return /android/i.test(userAgent);
}

export function isIOS(): boolean {
  const userAgent = navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(userAgent);
}

export function isMobile(): boolean {
  return isAndroid() || isIOS();
}

export function shouldUseCustomCamera(): boolean {
  // Use custom camera only on Android devices
  // iOS will use native camera input
  return isAndroid();
}
