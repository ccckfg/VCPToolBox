const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function toLocalDateString(date = new Date()) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function parseLocalDateTime(value) {
    if (!value || typeof value !== 'string') return null;

    const trimmed = value.trim();
    const match = trimmed.match(
        /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/
    );
    if (!match) return null;

    const [, yearRaw, monthRaw, dayRaw, hourRaw = '0', minuteRaw = '0', secondRaw = '0'] = match;
    const year = Number(yearRaw);
    const month = Number(monthRaw);
    const day = Number(dayRaw);
    const hour = Number(hourRaw);
    const minute = Number(minuteRaw);
    const second = Number(secondRaw);

    const date = new Date(year, month - 1, day, hour, minute, second, 0);
    if (Number.isNaN(date.getTime())) return null;
    return date;
}

function formatLocalDateTime(dateLike) {
    const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
    if (Number.isNaN(date.getTime())) return '未知时间';

    const datePart = toLocalDateString(date);
    const hour = String(date.getHours()).padStart(2, '0');
    const minute = String(date.getMinutes()).padStart(2, '0');
    return `${datePart} ${hour}:${minute}`;
}

function uniqueStrings(values) {
    return Array.from(new Set((values || []).filter(Boolean)));
}

function dotProduct(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
    let sum = 0;
    for (let i = 0; i < a.length; i++) {
        sum += a[i] * b[i];
    }
    return sum;
}

function magnitude(vector) {
    return Math.sqrt(dotProduct(vector, vector));
}

function normalize(vector) {
    const mag = magnitude(vector);
    if (!mag) return vector.map(() => 0);
    return vector.map((value) => value / mag);
}

function subtractVectors(a, b) {
    return a.map((value, index) => value - (b[index] || 0));
}

function addVectors(a, b) {
    return a.map((value, index) => value + (b[index] || 0));
}

function scaleVector(vector, scalar) {
    return vector.map((value) => value * scalar);
}

function averageVectors(vectors) {
    if (!Array.isArray(vectors) || vectors.length === 0) return [];
    const dimension = vectors[0].length;
    const accumulator = new Array(dimension).fill(0);

    for (const vector of vectors) {
        for (let i = 0; i < dimension; i++) {
            accumulator[i] += vector[i] || 0;
        }
    }

    return accumulator.map((value) => value / vectors.length);
}

function cosineSimilarity(a, b) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length || a.length === 0) {
        return 0;
    }
    const denominator = magnitude(a) * magnitude(b);
    if (!denominator) return 0;
    return dotProduct(a, b) / denominator;
}

module.exports = {
    DAY_MS,
    HOUR_MS,
    addVectors,
    averageVectors,
    clamp,
    cosineSimilarity,
    dotProduct,
    formatLocalDateTime,
    normalize,
    parseLocalDateTime,
    scaleVector,
    subtractVectors,
    toLocalDateString,
    uniqueStrings
};
