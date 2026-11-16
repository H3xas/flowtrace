namespace Ferry.Api.Filters;

public class GateFaultFilter : ExceptionFilterAttribute
{
    public override void OnException(ExceptionContext context)
    {
        if (context.Exception is GateClosedException)
        {
            context.Result = new StatusCodeResult(StatusCodes.Status423Locked);
        }
    }
}
