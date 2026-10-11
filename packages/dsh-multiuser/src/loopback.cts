export function isLoopbackAddress(address: string): boolean {
  if (address === "::1") return true;
  const octets = address.split(".");
  return octets.length === 4
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
    && Number(octets[0]) === 127;
}
