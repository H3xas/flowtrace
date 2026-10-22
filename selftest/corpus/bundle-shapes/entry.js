import describeShapes, * as shapes from './shapes.js';

console.log(JSON.stringify({ names: Object.keys(shapes).sort(), texts: shapes.texts(), default: describeShapes() }));
