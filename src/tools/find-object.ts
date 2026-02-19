export function findObject(opts: {in: any[], [key: string]: any}) {
    const { in: arr, ...criteria } = opts;
    return arr.find((obj) => {
        for (const [key, value] of Object.entries(criteria)) {
            if (obj[key] !== value) {
                return false;
            }
        }
        return true;
    });
}