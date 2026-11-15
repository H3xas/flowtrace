using Ferry.Api.Routes;
using Ferry.Api.Services;

namespace Ferry.Api.Controllers;

[Route(ApiRoutes.Decks.Lower)]
public class LowerDeckController : ControllerBase
{
    private readonly SeatMap _seats;

    public LowerDeckController(SeatMap seats)
    {
        _seats = seats;
    }

    [HttpGet("seats")]
    public IActionResult Seats()
    {
        return Ok(_seats.Lower());
    }
}
