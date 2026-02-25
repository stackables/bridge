# Collection of smaller missing or untested features

## Parenthesis

`o.currentTempF <- (w.current_weather.temperature * 9 / 5) + 32 ?? 32`

## Coalesce with try/catch

Current `||` operator does not catch errors? and they need to be handled with `??`, but this is a significant limitation on wire design.

```
  # TODO: A || B || C | D ?? E
  #    || - ignore error
  #    |  - jump to ?? on error 
```

## Assertions

`gecodeNode.q <- assert:i.cityName`

Standard tool for assertions. Usage examples etc. Currently throw on pipe does not cancel the wire? Bug?

## Pipe literals

`upper:"lower"` throws. but there is not real reason for it to throw

## if/else

While this makes the language too similar to programming languages it really helps with some more complicated mapping paths ... so need to decide, soon