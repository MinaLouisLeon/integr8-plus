/**
 * One tap from a job to turn-by-turn directions (P14), in whichever maps app
 * the phone uses.
 *
 * Coordinates are used when the site has them — a farm gate or a unit on an
 * industrial estate is rarely where its postcode lands — and the address when it
 * does not. Each platform gets a list to try in order: the first link the phone
 * can open wins, and the last one always opens something.
 */

export interface Destination {
  label: string;
  address: string;
  location: { latitude: number; longitude: number } | null;
}

export function navigationLinks(platform: 'ios' | 'android', to: Destination): string[] {
  const place =
    to.location === null
      ? encodeURIComponent(to.address)
      : `${String(to.location.latitude)},${String(to.location.longitude)}`;
  if (platform === 'ios') {
    return [
      `comgooglemaps://?daddr=${place}&directionsmode=driving`,
      `maps://?daddr=${place}&dirflg=d`,
      `https://maps.apple.com/?daddr=${place}&dirflg=d`,
    ];
  }
  const label = encodeURIComponent(to.label);
  return [
    `google.navigation:q=${place}&mode=d`,
    to.location === null ? `geo:0,0?q=${place}` : `geo:${place}?q=${place}(${label})`,
    `https://www.google.com/maps/dir/?api=1&destination=${place}&travelmode=driving`,
  ];
}
