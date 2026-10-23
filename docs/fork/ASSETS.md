# Asset store

## Version upload byte cap

Every file slot of a staged upload has the byte length its plan declared. The upload `PUT` never stores more than that:

- A request whose `Content-Length` is larger than the declared size gets `413 UPLOAD_TOO_LARGE`. The server answers before it reads any of the body.
- A body sent without a length is read through the verified stream, which fails at the first chunk past the declared size with `422 INVALID_INPUT`.

In both cases the slot stays unverified, so the upload cannot commit until a correct body arrives.
