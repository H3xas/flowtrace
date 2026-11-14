using Ferry.Api.Routes;
using Ferry.Api.Services;

namespace Ferry.Api.Endpoints;

[Route(
    ApiRoutes.Base + "/check-in")] // gate desk
public class CheckInEndpoint : EndpointBaseAsync
    .WithRequest<CheckInRequest>
    .WithActionResult<CheckInResult>
{
    private readonly GateDesk _gate;

    public CheckInEndpoint(GateDesk gate)
    {
        _gate = gate;
    }

    [HttpPost("{ticket}")] // one ticket at a time
    [SwaggerOperation(
        Summary = "Check one ticket in")]
    public override Task<ActionResult<CheckInResult>> HandleAsync(CheckInRequest request)
    {
        return _gate.Admit(request);
    }
}
