// The one spelling of a row's URL path: `<collection>/<id>`, with the id encoded. A text key may
// hold `/`, `#`, `?` or `%`, and an unencoded one opens another row's screen (`acme/edit` → the edit
// form of `acme`). The admin router decodes the segment back to the id.

/** `collection` is the resource's path, with or without the admin's base path before it. */
export const rowPath = (collection: string, id: string): string =>
  `${collection}/${encodeURIComponent(id)}`;
