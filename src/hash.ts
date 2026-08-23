/**
 * Pure-TypeScript SHA-256 / SHA-512 (FIPS 180-4).
 *
 * Dependency-free and synchronous, so hashes stay deterministic in any
 * runtime (Node or browser). Used by the Layer2 hash chain.
 */

const HEX_PAD = "00000000000000000000000000000000";

function to_hex(words: bigint[], width: number): string {
  return words.map((w) => w.toString(16).padStart(width, "0")).join("");
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const rotr32 = (x: number, n: number) => (x >>> n) | (x << (32 - n));

export function sha256_hex(message: string): string {
  const data = new TextEncoder().encode(message);
  const h = [
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ];

  const padded_len = (((data.length + 8) >> 6) + 1) << 6;
  const padded = new Uint8Array(padded_len);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded_len - 8, Math.floor((data.length * 8) / 0x100000000));
  view.setUint32(padded_len - 4, (data.length * 8) >>> 0);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded_len; off += 64) {
    for (let i = 0; i < 16; ++i) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; ++i) {
      const s0 = rotr32(w[i - 15]!, 7) ^ rotr32(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr32(w[i - 2]!, 17) ^ rotr32(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; ++i) {
      const S1 = rotr32(e!, 6) ^ rotr32(e!, 11) ^ rotr32(e!, 25);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (hh! + S1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const S0 = rotr32(a!, 2) ^ rotr32(a!, 13) ^ rotr32(a!, 22);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e;
      e = (d! + t1) >>> 0;
      d = c; c = b; b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0]! + a!) >>> 0;
    h[1] = (h[1]! + b!) >>> 0;
    h[2] = (h[2]! + c!) >>> 0;
    h[3] = (h[3]! + d!) >>> 0;
    h[4] = (h[4]! + e!) >>> 0;
    h[5] = (h[5]! + f!) >>> 0;
    h[6] = (h[6]! + g!) >>> 0;
    h[7] = (h[7]! + hh!) >>> 0;
  }

  return to_hex(h.map(BigInt), 8);
}

const SHA512_K = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
];

const MASK64 = (1n << 64n) - 1n;
const rotr64 = (x: bigint, n: bigint) => ((x >> n) | (x << (64n - n))) & MASK64;

export function sha512_hex(message: string): string {
  const data = new TextEncoder().encode(message);
  let h = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ];

  const padded_len = (((data.length + 16) >> 7) + 1) << 7;
  const padded = new Uint8Array(padded_len);
  padded.set(data);
  padded[data.length] = 0x80;
  const bits = BigInt(data.length) * 8n;
  for (let i = 0; i < 16; ++i) {
    padded[padded_len - 1 - i] = Number((bits >> BigInt(i * 8)) & 0xffn);
  }

  const w = new Array<bigint>(80);
  for (let off = 0; off < padded_len; off += 128) {
    for (let i = 0; i < 16; ++i) {
      let word = 0n;
      for (let j = 0; j < 8; ++j) word = (word << 8n) | BigInt(padded[off + i * 8 + j]!);
      w[i] = word;
    }
    for (let i = 16; i < 80; ++i) {
      const s0 = rotr64(w[i - 15]!, 1n) ^ rotr64(w[i - 15]!, 8n) ^ (w[i - 15]! >> 7n);
      const s1 = rotr64(w[i - 2]!, 19n) ^ rotr64(w[i - 2]!, 61n) ^ (w[i - 2]! >> 6n);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) & MASK64;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 80; ++i) {
      const S1 = rotr64(e!, 14n) ^ rotr64(e!, 18n) ^ rotr64(e!, 41n);
      const ch = (e! & f!) ^ (~e! & g!);
      const t1 = (hh! + S1 + ch + SHA512_K[i]! + w[i]!) & MASK64;
      const S0 = rotr64(a!, 28n) ^ rotr64(a!, 34n) ^ rotr64(a!, 39n);
      const maj = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (S0 + maj) & MASK64;
      hh = g; g = f; f = e;
      e = (d! + t1) & MASK64;
      d = c; c = b; b = a;
      a = (t1 + t2) & MASK64;
    }
    h = [
      (h[0]! + a!) & MASK64, (h[1]! + b!) & MASK64, (h[2]! + c!) & MASK64, (h[3]! + d!) & MASK64,
      (h[4]! + e!) & MASK64, (h[5]! + f!) & MASK64, (h[6]! + g!) & MASK64, (h[7]! + hh!) & MASK64,
    ];
  }

  return to_hex(h, 16);
}
