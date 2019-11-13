/**
 * Issue an id, possibly indicating that it belongs to/is namespaced by some
 * other previously issued id.
 */
export function generateId(type, parentId) {
  // The world's best id generator ever!
  let newId = type + ':' + Math.floor(Math.random() * 1000000000);
  if (parentId) {
    return newId + '@' + parentId;
  }
  return newId;
}
