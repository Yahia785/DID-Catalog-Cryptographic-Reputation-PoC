import type { VenueType } from '../shared/types.js';
import { SAMPLE_VENUES } from './sample-venues.js';

/**
 * The 13 test venues, in one place. Used by setup (DIDs), snapshot (data),
 * scoring and display.
 *
 * Each field tells a data source how to find this venue:
 *   issn       journals: OpenAlex, Crossref, SCImago
 *   coreId     conferences: ICORE portal id (also the ICORE CSV's first column)
 *   s2Venue    Semantic Scholar venue name (no commas: S2 splits on them)
 *   rwMatch    regex source matching the Retraction Watch "Journal" field
 */
export interface VenueEntry {
  key: string;            // short label used everywhere, e.g. 'SCN'
  slug: string;           // used in the DID handle, e.g. 'scn' → scn.journal.didcal.io
  name: string;
  type: VenueType;
  issn?: string;
  coreId?: string;
  s2Venue?: string;
  rwMatch?: string;
  rwExclude?: string;
  openalexId?: string;    // OpenAlex source id, e.g. S4210233669
  scimagoId?: string;     // SCImago Sourceid
  sampleStratum?: string; // e.g. "ICORE B", "Q2"
  role: string;           // why it is in the test set
}

const TEST_VENUES: VenueEntry[] = [
  // ── Conferences ──
  { key: 'S&P', openalexId: 'S4210233669', scimagoId: '84156', sampleStratum: 'ICORE A*', slug: 'ieee-sp', type: 'conference', name: 'IEEE Symposium on Security and Privacy',
    coreId: '750', s2Venue: 'IEEE Symposium on Security and Privacy',
    rwMatch: 'symposium on security and privacy', rwExclude: 'european|workshop', role: 'Top tier' },
  { key: 'CCS', openalexId: 'S4393917527', scimagoId: '110362', sampleStratum: 'ICORE A*', slug: 'acm-ccs', type: 'conference', name: 'ACM Conference on Computer and Communications Security',
    coreId: '12', s2Venue: 'Conference on Computer and Communications Security',
    rwMatch: 'conference on computer and communications? security', rwExclude: 'asia', role: 'Top tier' },
  { key: 'ACNS', sampleStratum: 'ICORE B', slug: 'acns', type: 'conference', name: 'Applied Cryptography and Network Security',
    coreId: '907', s2Venue: 'International Conference on Applied Cryptography and Network Security',
    rwMatch: 'applied cryptography and network security', role: 'Middle' },
  { key: 'PST', openalexId: 'S7407087549', sampleStratum: 'ICORE C', slug: 'pst', type: 'conference', name: 'Annual Conference on Privacy, Security and Trust',
    coreId: '127', s2Venue: 'PST', rwMatch: 'privacy,? security,? and trust', role: 'Low but legitimate' },
  { key: 'WASET', sampleStratum: 'not in ICORE', slug: 'waset', type: 'conference', name: 'World Academy of Science, Engineering and Technology',
    rwMatch: 'world academy of science', role: 'Widely characterized as predatory' },
  { key: 'ICIMTech', openalexId: 'S4363608260', sampleStratum: 'not in ICORE', slug: 'icimtech', type: 'conference', name: 'International Conference on Information Management and Technology',
    s2Venue: 'International Conference on Information Management and Technology',
    rwMatch: 'international conference on information management and technology', role: 'Indexed but compromised' },
  { key: 'IHIP', sampleStratum: 'not in ICORE', slug: 'ihip', type: 'conference', name: 'International Conference on Information Hiding and Image Processing',
    rwMatch: 'information hiding and image processing', role: 'Indexed but compromised' },

  // ── Journals ──
  { key: 'TIFS', openalexId: 'S61310614', scimagoId: '4000149002', sampleStratum: 'Q1', slug: 'ieee-tifs', type: 'journal', name: 'IEEE Transactions on Information Forensics and Security',
    issn: '1556-6013', s2Venue: 'IEEE Transactions on Information Forensics and Security',
    rwMatch: '^ieee transactions on information forensics and security', role: 'Top tier' },
  { key: 'Access', openalexId: 'S2485537415', scimagoId: '21100374601', sampleStratum: 'Q1', slug: 'ieee-access', type: 'journal', name: 'IEEE Access',
    issn: '2169-3536', s2Venue: 'IEEE Access', rwMatch: '^ieee access\\b', role: 'High-volume mega-journal' },
  { key: 'IJSN', openalexId: 'S146340630', scimagoId: '16800154719', sampleStratum: 'Q4', slug: 'ijsn', type: 'journal', name: 'International Journal of Security and Networks',
    issn: '1747-8405', s2Venue: 'International Journal of Security and Networks',
    rwMatch: '^international journal of security and networks', role: 'Low but legitimate' },
  { key: 'SCN', openalexId: 'S120683614', sampleStratum: 'not in SCImago', slug: 'scn', type: 'journal', name: 'Security and Communication Networks',
    issn: '1939-0114', s2Venue: 'Security and Communication Networks',
    rwMatch: '^security and communication networks', role: 'Lost indexing (Hindawi)' },
  { key: 'CIN', openalexId: 'S72372694', sampleStratum: 'not in SCImago', slug: 'cin', type: 'journal', name: 'Computational Intelligence and Neuroscience',
    issn: '1687-5265', s2Venue: 'Computational Intelligence and Neuroscience',
    rwMatch: '^computational intelligence and neuroscience', role: 'Compromised' },
  { key: 'JITSE', openalexId: 'S4210175862', sampleStratum: 'not in SCImago', slug: 'jitse', type: 'journal', name: 'Journal of Information Technology & Software Engineering',
    issn: '2165-7866', s2Venue: 'Journal of Information Technology & Software Engineering',
    rwMatch: '^journal of information technology (&|and) software engineering', role: 'Predatory (court-ruled publisher)' },
];

/** The 13 test venues followed by the sampled venues (src/venues/sample-venues.ts). */
export const VENUES: VenueEntry[] = [...TEST_VENUES, ...SAMPLE_VENUES];

/** The "area code" part of a venue's handle. */
export const groupOf = (type: VenueType) => (type === 'conference' ? 'conf' : 'journal');

/** Human-readable handle, e.g. 'scn.journal.didcal.io'. */
export const handleOf = (v: VenueEntry) => `${v.slug}.${groupOf(v.type)}.didcal.io`;

export const findVenue = (key: string) =>
  VENUES.find((v) => v.key.toLowerCase() === key.toLowerCase() || v.slug === key.toLowerCase());
