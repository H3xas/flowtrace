using Microsoft.AspNetCore.Mvc;
using KilnYard.Api.Services;

namespace KilnYard.Api.Controllers
{
    [ApiController]
    [Route("kiln/v1")]
    public class KilnController : ControllerBase
    {
        private readonly IFiringService _firing;

        public KilnController(IFiringService firing)
        {
            _firing = firing;
        }

        [HttpGet("kilns/{kilnId}/firings")]
        public IActionResult GetFirings(string kilnId)
        {
            if (string.IsNullOrEmpty(kilnId))
            {
                return BadRequest();
            }
            return Ok(_firing.List(kilnId));
        }
    }
}
