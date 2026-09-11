// The mania pp calculator lives under live-backend/src/dan/ so the backend can
// price unranked plays at store time (features/unrated-plays.ts); the frontend
// reaches it through the #dan alias like the dan estimator. Same module, one
// copy.
export * from "#dan/mania-pp";
