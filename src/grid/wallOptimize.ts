import { VisionBlockerType, WallPoint, WallSegment, generateLocalId, moreRestrictiveWallType } from "../data/mapData";
import { clamp, collinearOverlap, isStraightThrough, projectParam, segmentIntersection } from "./gridMath";

/**
 * Tolerance, as a fraction of a segment's own length, for treating a `t` parameter as landing "at"
 * 0/1 (an endpoint) rather than strictly inside — see `addWallSegment`.
 */
const WALL_T_EPSILON = 1e-4;

/**
 * The two arrays every wall network mutation here reads and rewrites — structurally just the two
 * relevant fields of a `Layer`, so a real `Layer` satisfies this directly, but also lets
 * `detectMagicWalls` build and reconcile a standalone candidate network before it's ever attached to
 * one.
 */
export interface WallNetwork {
	wallPoints: WallPoint[];
	wallSegments: WallSegment[];
}

/**
 * Adds a wall segment `aId`→`bId` to `network`, reconciling it against every already-committed
 * segment there first — walls aren't allowed to just cross or stack over each other invisibly:
 *  - A transversal crossing gets a shared point dropped right where the two lines meet, splitting
 *    the *existing* segment there so the two walls are actually joined, not just visually
 *    overlapping; the new segment is likewise split into sub-segments between crossings, so each
 *    sub-segment always sits between two real points.
 *  - A run that's collinear with (and overlaps) an existing segment doesn't get a second, stacked
 *    segment for the shared stretch — that stretch keeps a single segment, using whichever of the
 *    two blocker types is more restrictive (see `moreRestrictiveWallType`).
 * Mutates `network` in place. Must run inside `MapController.update`'s mutator when `network` is a
 * live layer (one history entry per commit, however many points/segments it ends up touching — see
 * `MapController.commitWallPoint`).
 *
 * Returns whether `bId` — the point just placed, as opposed to `aId`, the chain's already-
 * established previous point — ended up touching some *other* wall (its line, or one of its own
 * points) in the process, which `MapController.commitWallPoint` treats as "joined a wall", finishing
 * the chain. `detectMagicWalls`/`optimizeWallNetwork` (batch callers, not interactive drawing) ignore
 * this return value.
 */
export function addWallSegment(network: WallNetwork, aId: string, bId: string, blockerType: VisionBlockerType): boolean {
	if (aId === bId) return false;
	const pointsById = new Map(network.wallPoints.map((p) => [p.id, p]));
	const a = pointsById.get(aId);
	const b = pointsById.get(bId);
	if (!a || !b) return false;

	const eps = WALL_T_EPSILON;
	/** Reuses whichever WallPoint already sits at `pt` (within a hair of floating-point noise) instead of stacking a near-duplicate. */
	const pointAt = (pt: { x: number; y: number }): string => {
		for (const p of network.wallPoints) {
			if (Math.hypot(p.x - pt.x, p.y - pt.y) < 1e-4) return p.id;
		}
		const point: WallPoint = { id: generateLocalId("wallpoint"), x: pt.x, y: pt.y };
		network.wallPoints.push(point);
		pointsById.set(point.id, point);
		return point.id;
	};

	// Every point the final a→b chain of sub-segments must pass through, keyed by its `t` along
	// a→b (0 = a, 1 = b) so they sort/dedupe naturally; the two ends are always included.
	const cuts = new Map<number, string>([
		[0, aId],
		[1, bId],
	]);
	// t-ranges of the new segment an existing wall already covers — resolved as part of that
	// existing wall's own rebuild below, so the final a→b pass must skip re-creating a stacked
	// duplicate there.
	const coveredRanges: { t0: number; t1: number }[] = [];
	let joinedOtherWall = false;

	const existingSegments = network.wallSegments;
	const keptSegments: WallSegment[] = [];
	for (const existing of existingSegments) {
		const ea = pointsById.get(existing.aId);
		const eb = pointsById.get(existing.bId);
		if (!ea || !eb) {
			keptSegments.push(existing);
			continue;
		}

		const overlap = collinearOverlap(a, b, ea, eb);
		if (overlap) {
			const { t0, t1 } = overlap;
			const startPt = { x: a.x + t0 * (b.x - a.x), y: a.y + t0 * (b.y - a.y) };
			const endPt = { x: a.x + t1 * (b.x - a.x), y: a.y + t1 * (b.y - a.y) };
			const startId = t0 <= eps ? aId : t0 >= 1 - eps ? bId : pointAt(startPt);
			const endId = t1 <= eps ? aId : t1 >= 1 - eps ? bId : pointAt(endPt);
			cuts.set(t0, startId);
			cuts.set(t1, endId);
			coveredRanges.push({ t0, t1 });
			if (t1 >= 1 - eps) joinedOtherWall = true;

			// Rebuild `existing` around the overlap: whatever of its own extent sits outside
			// [t0, t1] keeps its original type as its own segment(s); the shared middle becomes
			// one merged segment, the more restrictive of the two types winning.
			const winningType: VisionBlockerType = moreRestrictiveWallType(existing.blockerType, blockerType);
			const teA = projectParam(ea, a, b);
			const teB = projectParam(eb, a, b);
			const [loT, loId, hiT, hiId] = teA <= teB ? [teA, existing.aId, teB, existing.bId] : [teB, existing.bId, teA, existing.aId];
			if (loT < t0 - eps) keptSegments.push({ id: generateLocalId("wallsegment"), aId: loId, bId: startId, blockerType: existing.blockerType });
			if (hiT > t1 + eps) keptSegments.push({ id: generateLocalId("wallsegment"), aId: endId, bId: hiId, blockerType: existing.blockerType });
			keptSegments.push({ id: generateLocalId("wallsegment"), aId: startId, bId: endId, blockerType: winningType });
			continue;
		}

		const cross = segmentIntersection(a, b, ea, eb);
		if (!cross) {
			keptSegments.push(existing);
			continue;
		}
		const t = clamp(projectParam(cross, a, b), 0, 1);
		const u = clamp(projectParam(cross, ea, eb), 0, 1);
		const uInterior = u > eps && u < 1 - eps;

		if (t > eps && t < 1 - eps) {
			// A genuine interior crossing (an "X") — split both segments at a shared new point,
			// or route through whichever of the existing segment's own endpoints it lands on.
			if (uInterior) {
				const crossPointId = pointAt(cross);
				cuts.set(t, crossPointId);
				keptSegments.push(
					{ id: generateLocalId("wallsegment"), aId: existing.aId, bId: crossPointId, blockerType: existing.blockerType },
					{ id: generateLocalId("wallsegment"), aId: crossPointId, bId: existing.bId, blockerType: existing.blockerType }
				);
			} else {
				cuts.set(t, u <= 0.5 ? existing.aId : existing.bId);
				keptSegments.push(existing);
			}
		} else if (t >= 1 - eps && uInterior) {
			// `b` — the point just placed — lands mid-way along an existing wall's line: a
			// T-junction. Split the existing segment there (reusing `bId`, no new point needed)
			// and flag this as "joined an existing wall" for `commitWallPoint`.
			keptSegments.push(
				{ id: generateLocalId("wallsegment"), aId: existing.aId, bId, blockerType: existing.blockerType },
				{ id: generateLocalId("wallsegment"), aId: bId, bId: existing.bId, blockerType: existing.blockerType }
			);
			joinedOtherWall = true;
		} else if (t <= eps && uInterior) {
			// `a` — the chain's already-established point — sits mid-way along an existing wall's
			// line (typically because it was itself placed there via a T-junction snap). Split the
			// existing segment there too, for the same connectivity reason, but this doesn't count
			// as "just joined" — `a` wasn't the point placed by *this* click.
			keptSegments.push(
				{ id: generateLocalId("wallsegment"), aId: existing.aId, bId: aId, blockerType: existing.blockerType },
				{ id: generateLocalId("wallsegment"), aId, bId: existing.bId, blockerType: existing.blockerType }
			);
		} else {
			keptSegments.push(existing);
		}
	}

	const sortedTs = Array.from(cuts.keys()).sort((x, y) => x - y);
	const uniqueTs: number[] = [];
	for (const t of sortedTs) {
		if (uniqueTs.length === 0 || t - (uniqueTs[uniqueTs.length - 1] as number) > eps) uniqueTs.push(t);
	}
	const newSegments: WallSegment[] = [];
	for (let i = 0; i < uniqueTs.length - 1; i++) {
		const t0 = uniqueTs[i] as number;
		const t1 = uniqueTs[i + 1] as number;
		const mid = (t0 + t1) / 2;
		if (coveredRanges.some((r) => mid > r.t0 - eps && mid < r.t1 + eps)) continue;
		const fromId = cuts.get(t0);
		const toId = cuts.get(t1);
		if (!fromId || !toId) continue;
		newSegments.push({ id: generateLocalId("wallsegment"), aId: fromId, bId: toId, blockerType });
	}

	network.wallSegments = [...keptSegments, ...newSegments];
	return joinedOtherWall;
}

/**
 * Repeatedly finds a wall point with exactly two segments touching it, both the same blocker type,
 * whose far ends sit in a dead-straight line through it (`isStraightThrough` — a real corner, or a
 * junction with a third branch, is left alone), and merges that pair into one direct segment.
 * Doesn't remove the now-unreferenced middle point itself — callers purge orphan points as a
 * separate pass (see `optimizeWallNetwork`) rather than duplicating that filter here. Loops until a
 * full scan finds nothing left to merge, since collapsing one point can straighten out its
 * neighbor's line too. Mutates `network` in place.
 */
export function mergeStraightWallPoints(network: WallNetwork): void {
	let merged = true;
	while (merged) {
		merged = false;
		const pointsById = new Map(network.wallPoints.map((p) => [p.id, p]));
		for (const point of network.wallPoints) {
			const touching = network.wallSegments.filter((s) => s.aId === point.id || s.bId === point.id);
			if (touching.length !== 2) continue;
			const [s1, s2] = touching as [WallSegment, WallSegment];
			if (s1.blockerType !== s2.blockerType) continue;
			const otherId1 = s1.aId === point.id ? s1.bId : s1.aId;
			const otherId2 = s2.aId === point.id ? s2.bId : s2.aId;
			if (otherId1 === otherId2) continue;
			const other1 = pointsById.get(otherId1);
			const other2 = pointsById.get(otherId2);
			if (!other1 || !other2 || !isStraightThrough(other1, point, other2)) continue;
			network.wallSegments = network.wallSegments.filter((s) => s.id !== s1.id && s.id !== s2.id);
			network.wallSegments.push({ id: generateLocalId("wallsegment"), aId: otherId1, bId: otherId2, blockerType: s1.blockerType });
			merged = true;
			break;
		}
	}
}

/**
 * Full cleanup pass over a wall network, without changing what it actually blocks — shared by
 * `MapController.optimizeWalls` ("Optimiser les murs", run on a hand-edited layer in place) and
 * `detectMagicWalls` (run on a freshly-built candidate network before it's ever shown to the user):
 *  1. Points no segment touches — dropped outright.
 *  2. Overlapping/duplicate segments — collapsed via `addWallSegment`'s own reconciliation (the more
 *     restrictive type winning for the shared stretch, see `moreRestrictiveWallType`), by re-inserting
 *     every existing segment through it, one at a time, into a network rebuilt from scratch.
 *  3. Redundant straight-line middle points — collapsed via `mergeStraightWallPoints`.
 * Mutates `network` in place.
 */
export function optimizeWallNetwork(network: WallNetwork): void {
	// 1) Orphan points first, so step 2 only has to reason about points that actually matter.
	network.wallPoints = network.wallPoints.filter((p) => network.wallSegments.some((s) => s.aId === p.id || s.bId === p.id));

	// 2) Overlapping/duplicate segments, opaque winning over dim.
	const originalSegments = network.wallSegments;
	network.wallSegments = [];
	for (const segment of originalSegments) {
		addWallSegment(network, segment.aId, segment.bId, segment.blockerType);
	}

	// 3) Redundant straight-line middle points.
	mergeStraightWallPoints(network);

	// 4) `mergeStraightWallPoints` deliberately leaves the points it collapses in place (it only
	// rewires the segments); sweep those — and anything else left touching nothing — out now rather
	// than duplicating this same filter inside it.
	network.wallPoints = network.wallPoints.filter((p) => network.wallSegments.some((s) => s.aId === p.id || s.bId === p.id));
}
