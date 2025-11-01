// Device detection utilities

export function isAndroid(): boolean {
  const userAgent = navigator.userAgent.toLowerCase();
  const platform = navigator.platform?.toLowerCase() || '';
  
  // Check User Agent for Android
  const hasAndroidUA = /android/i.test(userAgent);
  
  // Check platform (works even in desktop mode)
  const hasAndroidPlatform = platform.includes('android') || platform.includes('linux arm');
  
  // Check for touch support (Android devices have touch)
  const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  
  // If User Agent says Android, definitely Android
  if (hasAndroidUA) return true;
  
  // If platform suggests Android, it's Android
  if (hasAndroidPlatform) return true;
  
  // If has touch + Linux platform (common for Android in desktop mode)
  if (hasTouch && platform.includes('linux')) return true;
  
  return false;
}

export function isIOS(): boolean {
  const userAgent = navigator.userAgent.toLowerCase();
  return /iphone|ipad|ipod/.test(userAgent);
}

export function isMobile(): boolean {
  return isAndroid() || isIOS();
}

export function shouldUseCustomCamera(): boolean {
  // Use custom camera only on Android devices (including tablets)
  // iOS will use native camera input
  // Works even when browser is in "Desktop Site" mode
  return isAndroid();
}
