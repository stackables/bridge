# Collection of smaller missing or untested features

## Parenthesis

`o.currentTempF <- (w.current_weather.temperature * 9 / 5) + 32 ?? 32`

## Coalesce with error boundary

The `||` and `??` operators handle falsy/nullish data. Error boundaries use the `catch` keyword.

```bridge
  # A || B || C with fallback catch error boundary:
  o.label <- A || B || C || "default" catch errorSource
  #    || - fires on falsy/null
  #    catch - fires on error/exception
```

## Assertions

`gecodeNode.q <- assert:i.cityName`

Standard tool for assertions. Usage examples etc. Currently throw on pipe does not cancel the wire? Bug?

## Pipe literals

`upper:"lower"` throws. but there is not real reason for it to throw

## if/else

While this makes the language too similar to programming languages it really helps with some more complicated mapping paths ... so need to decide, soon

## Per tool trace and log levels

Somehow allow tools to define at which levels to send the traces ... for a "uppercase" tool call it makes sense to send a span and log only on error?

This goes with the batching idea of tool metadata.