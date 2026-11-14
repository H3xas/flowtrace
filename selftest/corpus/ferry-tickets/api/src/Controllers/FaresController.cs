using Ferry.Api.Routes;
using Ferry.Api.Services;

namespace Ferry.Api.Controllers;

[Route("fares")]
public class FaresController : ControllerBase
{
    private readonly FareDesk _desk;

    public FaresController(FareDesk desk)
    {
        _desk = desk;
    }

    [HttpGet(FareRoutes.Missing)]
    public IActionResult Quote()
    {
        return Ok(_desk.Quote());
    }

    [HttpGet(LoopRoutes.First)]
    public IActionResult Loop()
    {
        return Ok(_desk.Loop());
    }

    [HttpGet(Twin.Key)]
    public IActionResult Either()
    {
        return Ok(_desk.Either());
    }

    [HttpGet(FareRoutes.Window + RouteText.Build())]
    public IActionResult Built()
    {
        return Ok(_desk.Built());
    }

    [HttpGet(OpsRoutes.Ping)]
    public IActionResult Elsewhere()
    {
        return Ok(_desk.Elsewhere());
    }

    [HttpGet("window", Name = FareRoutes.Missing)]
    public IActionResult Named()
    {
        return Ok(_desk.Named());
    }
}
